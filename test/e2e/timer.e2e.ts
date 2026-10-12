import { readFileSync } from 'node:fs';
import { browser, expect } from '@wdio/globals';
import { obsidianPage } from 'wdio-obsidian-service';
import { pluginId, reloadPlugin } from './load';

// Real-app checks against a STUBBED Clockify (test/e2e/stub-clockify.js): no real token, no real request. The stub also fixes the
// clock at 14:00 local time, so the day total is the same on each run: 3 entries, 160 minutes. Pro is switched on with a
// stubbed GitHub Sponsors answer ($5 a month), the same way as in the other products.
const STUB = readFileSync('test/e2e/stub-clockify.js', 'utf8');
const KEY = 'stub-key-0000';
const WS = 'a1b2c3d4e5f6a1b2c3d4e5f6';
const UID = '0a0b0c0d0e0f0a0b0c0d0e0f';
const DOCS = '5b641568b07987035750505e';
const CODE = '5b641568b07987035750505f';
const USER_LIST = `/workspaces/${WS}/user/${UID}/time-entries`;

interface Call {
	method: string;
	path: string;
	body: Record<string, unknown> | null;
	key: string;
	auth: string | undefined;
}

const calls = (): Promise<Call[]> => browser.execute(() => ((window as unknown as { __tmtStub: { calls: Call[] } }).__tmtStub.calls));
const setMode = (mode: string): Promise<void> => browser.execute((m: string) => void ((window as unknown as { __tmtStub: { mode: string } }).__tmtStub.mode = m), mode);

async function installStub(): Promise<void> {
	await browser.executeObsidian(({ app }, src) => new Function('app', `return ${src}`)(app) as string, STUB);
}

/** Runs js in the app with the plugin as p. Returns the JSON-safe result. */
async function inPlugin<T>(js: string): Promise<T> {
	return browser.executeObsidian(({ app }, id, code) => {
		const p = (app as unknown as { plugins: { plugins: Record<string, unknown> } }).plugins.plugins[id];
		return new Function('app', 'p', `return (${code})`)(app, p) as T;
	}, pluginId, js);
}

async function setPro(on: boolean): Promise<void> {
	await browser.executeObsidian(
		async ({ app }, id, value) => {
			interface Pro {
				opts: { http: unknown };
				refreshNow(): Promise<void>;
				signOut(): void;
			}
			const p = (app as unknown as { plugins: { plugins: Record<string, { pro: Pro }> } }).plugins.plugins[id]!;
			if (!value) {
				p.pro.signOut();
				return;
			}
			const reply = { status: 200, json: { data: { viewer: { login: 'demo-reader' }, user: { sponsorshipForViewerAsSponsor: { isActive: true, isOneTimePayment: false, tier: { name: '$5 a month', monthlyPriceInCents: 500 } } } } } };
			p.pro.opts.http = () => Promise.resolve(reply);
			app.secretStorage.setSecret(`${id}-github-token`, 'gho_' + '0'.repeat(36));
			await p.pro.refreshNow();
		},
		pluginId,
		on,
	);
}

/** Forgets the request list and the back off block, so the next test starts clean. */
async function freshBudget(): Promise<void> {
	await inPlugin<string>("(() => { const b = p.service.deps.client.budget; b.blockedUntilMs = 0; b.failures = 0; b.sent = []; return 'ok'; })()");
}

async function openPreview(path: string): Promise<void> {
	await browser.executeObsidian(async ({ app }, file) => {
		const f = app.vault.getFileByPath(file);
		if (f) await app.workspace.getLeaf(false).openFile(f, { state: { mode: 'preview' } });
	}, path);
}

const count = (sel: string): Promise<number> => browser.execute((q: string) => document.querySelectorAll(q).length, sel);
const texts = (sel: string): Promise<string[]> => browser.execute((q: string) => Array.from(document.querySelectorAll(q)).map((e) => e.textContent ?? ''), sel);

const state = (): Promise<{ status: string; current: string | null; today: number; pending: number }> =>
	inPlugin("({ status: p.service.status(), current: p.service.current()?.description ?? null, today: p.service.todaySeconds(), pending: p.service.pending() })");

describe(`${pluginId} in the real app`, function () {
	it('is enabled and reloads with no console errors', async function () {
		const s = await reloadPlugin(pluginId);
		expect(s).toEqual({ enabled: true, reloaded: true, errors: [] });
	});

	it('has no key on a new install and sends no request', async function () {
		expect((await state()).status).toBe('nolink');
		const sent = await inPlugin<boolean>('p.service.start({ description: "x", projectId: null, tags: [] })');
		expect(sent).toBe(false);
	});
});

describe(`${pluginId} free tier with a stubbed Clockify`, function () {
	before(async function () {
		await setPro(false);
		await installStub();
	});

	it('the first background refresh costs two requests (user, then entries) and gives the day total of 2 h 40 min', async function () {
		await inPlugin<boolean>('p.service.refresh({ force: true, background: true })');
		const c = await calls();
		expect(c).toHaveLength(2);
		expect(c[0]?.path).toBe('/user');
		expect(c[1]?.path.startsWith(`${USER_LIST}?hydrated=true&page-size=500&start=`)).toBe(true);
		expect(c[1]?.key).toBe(KEY);
		expect(c[1]?.auth ?? null).toBeNull();
		const s = await state();
		expect(s.today).toBe(9600);
		expect(s.current).toBeNull();
	});

	it('keeps the key out of data.json', async function () {
		await inPlugin<string>("(p.persist(), 'ok')");
		await browser.pause(300);
		const raw = await browser.executeObsidian(({ app }, id) => app.vault.adapter.read(`.obsidian/plugins/${id}/data.json`), pluginId);
		expect(raw).not.toContain(KEY);
		expect(raw).toContain('tokenSecretId');
	});

	it('Start timer opens a modal; typing a description and selecting Start sends one POST', async function () {
		await browser.executeObsidianCommand(`${pluginId}:start`);
		await browser.$('.tmt-modal input').waitForExist({ timeout: 5000 });
		await browser.execute(() => {
			const input = document.querySelector<HTMLInputElement>('.tmt-modal input')!;
			input.value = 'Draft the release notes';
			input.dispatchEvent(new Event('input', { bubbles: true }));
			document.querySelector<HTMLButtonElement>('.tmt-modal button.mod-cta')!.click();
		});
		await browser.waitUntil(async () => (await calls()).some((c) => c.method === 'POST'), { timeout: 8000, timeoutMsg: 'no POST' });
		const post = (await calls()).find((c) => c.method === 'POST')!;
		expect(post.path).toBe(`/workspaces/${WS}/time-entries`);
		expect(post.body).toMatchObject({ description: 'Draft the release notes' });
		expect(post.body).not.toHaveProperty('end');
		expect(post.body).not.toHaveProperty('projectId');
		expect((await state()).current).toBe('Draft the release notes');
	});

	it('shows the running timer in the status bar and in the panel', async function () {
		await browser.waitUntil(async () => (await browser.$('.status-bar .tmt-status').getText()).includes('Draft the release notes'), { timeout: 5000 });
		await browser.executeObsidianCommand(`${pluginId}:open-panel`);
		await browser.waitUntil(async () => (await texts('.tmt-panel .tmt-pill-text')).some((t) => t.includes('Draft the release notes')), { timeout: 8000, timeoutMsg: 'panel pill text' });
		await browser.waitUntil(async () => (await texts('.tmt-panel .tmt-today')).some((t) => /^Today 2h 4\dm$/.test(t)), { timeout: 8000, timeoutMsg: 'panel day total' });
		expect(await count('.tmt-panel .tmt-row')).toBe(3);
		expect(await count('.tmt-panel .tmt-edit')).toBe(0);
	});

	it('Stop sends one PATCH and the entry joins the list', async function () {
		const before = (await calls()).length;
		await browser.executeObsidianCommand(`${pluginId}:stop`);
		await browser.waitUntil(async () => (await state()).current === null, { timeout: 8000 });
		const c = (await calls()).slice(before);
		expect(c.map((x) => x.method)).toEqual(['PATCH']);
		expect(c[0]?.path).toBe(USER_LIST);
		expect(c[0]?.body).toHaveProperty('end');
		expect(await count('.tmt-panel .tmt-row')).toBe(4);
	});

	it('Start timer for this note uses the note name and, without Pro, ignores the clockify-project property', async function () {
		await obsidianPage.openFile('Notes/Project plan.md');
		await browser.pause(500);
		await browser.executeObsidianCommand(`${pluginId}:start-note`);
		await browser.waitUntil(async () => (await state()).current === 'Project plan', { timeout: 8000 });
		const post = (await calls()).filter((c) => c.method === 'POST').at(-1)!;
		expect(post.body).not.toHaveProperty('projectId');
		await browser.executeObsidianCommand(`${pluginId}:stop`);
		await browser.waitUntil(async () => (await state()).current === null, { timeout: 8000 });
	});

	it('Start timer for this task uses the cleaned line at the cursor, and an empty line offers no command', async function () {
		await browser.executeObsidian(async ({ app }) => {
			const path = 'Notes/Task list.md';
			const text = '- [ ] Write the [[People/Alice Smith|Alice]] reply \u{1F4C5} 2026-10-16\n\n';
			const old = app.vault.getFileByPath(path);
			if (old) await app.vault.modify(old, text);
			else await app.vault.create(path, text);
			const leaf = app.workspace.getLeaf(false);
			await leaf.openFile(app.vault.getFileByPath(path)!, { state: { mode: 'source' } });
		});
		await browser.pause(500);
		// checkCallback(true) is what the command palette asks; checkCallback(false) runs the command.
		const run = (line: number, checking: boolean): Promise<{ text: string; ok: boolean }> =>
			browser.executeObsidian(({ app }, id, ln, chk) => {
				const editor = app.workspace.activeEditor!.editor!;
				editor.setCursor({ line: ln, ch: 0 });
				const cmd = (app as unknown as { commands: { findCommand(c: string): { checkCallback(c: boolean): boolean | void } } }).commands.findCommand(`${id}:start-task`);
				return { text: editor.getLine(ln), ok: cmd.checkCallback(chk) === true };
			}, pluginId, line, checking);
		const before = (await calls()).length;
		expect(await run(1, true)).toEqual({ text: '', ok: false });
		await run(1, false);
		await browser.pause(300);
		expect((await calls()).length).toBe(before);
		expect((await run(0, true)).ok).toBe(true);
		await run(0, false);
		await browser.waitUntil(async () => (await state()).current === 'Write the Alice reply', { timeout: 8000 });
		const post = (await calls()).filter((c) => c.method === 'POST').at(-1)!;
		expect(post.body).toMatchObject({ description: 'Write the Alice reply' });
		await browser.executeObsidianCommand(`${pluginId}:stop`);
		await browser.waitUntil(async () => (await state()).current === null, { timeout: 8000 });
	});

	it('HTTP 429 stops all requests until the wait ends and the pill says so', async function () {
		await setMode('429');
		const before = (await calls()).length;
		for (let i = 0; i < 6; i++) await inPlugin<boolean>('p.service.refresh({ force: true })');
		expect((await calls()).length - before).toBe(1);
		expect((await state()).status).toBe('limited');
		expect(await inPlugin<string>('p.pillText()')).toMatch(/^Request limit reached, retry in \d+ min$/);
		await setMode('ok');
		await freshBudget();
	});

	it('a server error backs off the same way', async function () {
		await setMode('503');
		const before = (await calls()).length;
		for (let i = 0; i < 4; i++) await inPlugin<boolean>('p.service.refresh({ force: true })');
		expect((await calls()).length - before).toBe(1);
		await setMode('ok');
		await freshBudget();
	});

	it('without Pro an offline start changes nothing', async function () {
		await setMode('offline');
		const ok = await inPlugin<boolean>('p.service.start({ description: "Offline", projectId: null, tags: [] })');
		expect(ok).toBe(false);
		const s = await state();
		expect(s.pending).toBe(0);
		expect(s.current).toBeNull();
		await setMode('ok');
		await freshBudget();
	});

	it('the report block is locked and sends no request', async function () {
		const before = (await calls()).length;
		await openPreview('Notes/Locked report.md');
		await browser.$('.tmt-locked').waitForExist({ timeout: 5000 });
		expect((await texts('.tmt-locked')).some((t) => /pro feature/.test(t))).toBe(true);
		expect((await calls()).length).toBe(before);
	});
});

describe(`${pluginId} Pro tier with a stubbed Clockify and a stubbed GitHub`, function () {
	before(async function () {
		await setPro(true);
		await freshBudget();
	});
	after(async function () {
		await setPro(false);
	});

	it('the report block shows hours by project and by day from one request', async function () {
		await inPlugin<boolean>('p.service.refresh({ force: true })');
		const before = (await calls()).filter((c) => c.path.includes('start=')).length;
		await openPreview('Notes/Weekly report.md');
		await browser.waitUntil(async () => (await count('.tmt-report-table')) >= 2, { timeout: 8000, timeoutMsg: 'two report tables expected' });
		const rows = await browser.execute(() => Array.from(document.querySelectorAll('.tmt-report-table tr')).map((r) => r.textContent ?? ''));
		expect(rows.some((t) => t.includes('Docs') && t.endsWith('1.42'))).toBe(true);
		expect(rows.some((t) => t.includes('Code') && t.endsWith('1.25'))).toBe(true);
		expect(rows.filter((t) => t.startsWith('Total')).every((t) => t.endsWith('2.67'))).toBe(true);
		expect((await calls()).filter((c) => c.path.includes('start=')).length - before).toBe(1);
	});

	it('the clockify-project property sets the project of a timer started from a note', async function () {
		await inPlugin<string>("(p.service.loadProjects(true), 'ok')");
		await browser.pause(400);
		await obsidianPage.openFile('Notes/Project plan.md');
		await browser.pause(600);
		await browser.executeObsidianCommand(`${pluginId}:start-note`);
		await browser.waitUntil(async () => (await state()).current === 'Project plan', { timeout: 8000 });
		const post = (await calls()).filter((c) => c.method === 'POST').at(-1)!;
		expect(post.body).toMatchObject({ description: 'Project plan', projectId: CODE });
		await browser.executeObsidianCommand(`${pluginId}:stop`);
		await browser.waitUntil(async () => (await state()).current === null, { timeout: 8000 });
	});

	it('offline start and stop wait in the queue and go out as ONE request', async function () {
		await setMode('offline');
		await inPlugin<boolean>('p.service.start({ description: "Offline work", projectId: "5b641568b07987035750505e", tags: [] })');
		expect((await state()).current).toBe('Offline work');
		await browser.pause(1200);
		await inPlugin<boolean>('p.service.stop()');
		const s = await state();
		expect(s.pending).toBe(2);
		await browser.executeObsidianCommand(`${pluginId}:open-panel`);
		await browser.$('.tmt-queue').waitForExist({ timeout: 5000 });
		expect(await browser.$('.tmt-queue').getText()).toMatch(/2 changes wait/);
		await setMode('ok');
		await freshBudget();
		const before = (await calls()).length;
		await inPlugin<number>('p.service.flushQueue()');
		const sent = (await calls()).slice(before);
		const posts = sent.filter((c) => c.method === 'POST');
		expect(posts).toHaveLength(1);
		expect(posts[0]?.body).toMatchObject({ description: 'Offline work', projectId: DOCS });
		expect(posts[0]?.body).toHaveProperty('end');
		expect((await state()).pending).toBe(0);
	});

	it('edit and delete work from the panel', async function () {
		await browser.executeObsidianCommand(`${pluginId}:open-panel`);
		await browser.$('.tmt-panel .tmt-edit').waitForExist({ timeout: 5000 });
		await browser.execute(() => document.querySelector<HTMLButtonElement>('.tmt-panel .tmt-edit')!.click());
		await browser.$('.tmt-modal').waitForExist({ timeout: 5000 });
		await browser.execute(() => {
			const input = document.querySelector<HTMLInputElement>('.tmt-modal input')!;
			input.value = 'Renamed entry';
			input.dispatchEvent(new Event('input', { bubbles: true }));
			Array.from(document.querySelectorAll<HTMLButtonElement>('.tmt-modal button')).find((b) => b.textContent === 'Save')!.click();
		});
		await browser.waitUntil(async () => (await calls()).some((c) => c.method === 'PUT'), { timeout: 8000 });
		const put = (await calls()).filter((c) => c.method === 'PUT').at(-1)!;
		expect(put.body).toMatchObject({ description: 'Renamed entry' });
		await browser.waitUntil(async () => (await texts('.tmt-panel .tmt-desc')).includes('Renamed entry'), { timeout: 5000 });
		const n = await count('.tmt-panel .tmt-row');
		await browser.execute(() => document.querySelector<HTMLButtonElement>('.tmt-panel .tmt-edit')!.click());
		await browser.$('.tmt-modal').waitForExist({ timeout: 5000 });
		await browser.execute(() => {
			const del = Array.from(document.querySelectorAll<HTMLButtonElement>('.tmt-modal button')).find((b) => b.textContent === 'Delete')!;
			del.click();
			Array.from(document.querySelectorAll<HTMLButtonElement>('.tmt-modal button')).find((b) => b.textContent?.startsWith('Select again'))!.click();
		});
		await browser.waitUntil(async () => (await calls()).some((c) => c.method === 'DELETE'), { timeout: 8000 });
		await browser.waitUntil(async () => (await count('.tmt-panel .tmt-row')) === n - 1, { timeout: 5000 });
	});

	it('turning Pro off hides the edit buttons', async function () {
		await setPro(false);
		await browser.waitUntil(async () => (await count('.tmt-panel .tmt-edit')) === 0, { timeout: 5000 });
	});
});
