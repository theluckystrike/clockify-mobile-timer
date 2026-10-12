import { describe, expect, it } from 'vitest';
import { ClockifyClient, MAX_PAGES, PAGE_SIZE, type Http } from '../src/client';
import { FakeClockify, PROJ_CODE, PROJ_DOCS, TAG_X, UID, WS, wireEntry } from './fake-clockify';
import { TimerService, emptyState, normalizeState, type ServiceDeps } from '../src/service';

const T0 = Date.parse('2026-10-10T08:00:00Z');

function make(pro: boolean, fake: FakeClockify, clock: { now: number }, token: string | null = 'secret-token-123') {
	const messages: string[] = [];
	const client = new ClockifyClient({ getToken: () => token, http: fake.http, now: () => clock.now, onBudget: () => undefined });
	const deps: ServiceDeps = {
		client,
		now: () => clock.now,
		tzOffsetMin: () => 0,
		isPro: () => pro,
		hasToken: () => token !== null,
		notify: (m) => messages.push(m),
		save: () => undefined,
		ttlMs: () => 600_000,
		weekStart: () => 1,
	};
	return { svc: new TimerService(deps, emptyState()), messages, client };
}

const RUNNING_ID = 'ee00000000000000000000e7';
const ID9 = 'ee0000000000000000000009';
const entriesPath = `/workspaces/${WS}/user/${UID}/time-entries`;

describe('TimerService', () => {
	it('the first refresh asks who you are (2 requests), later ones use 1, and a fresh cache uses none', async () => {
		const fake = new FakeClockify();
		fake.entries = [wireEntry('ee0000000000000000000001', '2026-10-10T06:00:00Z', '2026-10-10T07:00:00Z', { description: 'Earlier' })];
		const clock = { now: T0 };
		const { svc } = make(false, fake, clock);
		expect(await svc.refresh()).toBe(true);
		expect(fake.calls.map((c) => c.path.split('?')[0])).toEqual(['/user', entriesPath]);
		expect(fake.calls[1]?.path).toContain('hydrated=true&page-size=500&start=');
		clock.now += 5 * 60_000;
		await svc.refresh({ background: true });
		expect(fake.calls).toHaveLength(2);
		expect(svc.todaySeconds()).toBe(3600);
		clock.now += 6 * 60_000;
		await svc.refresh({ background: true });
		expect(fake.calls).toHaveLength(3);
	});

	it('a manual refresh also asks for the running timer, so a timer from before yesterday shows; a background refresh does not', async () => {
		const fake = new FakeClockify();
		fake.current = wireEntry('ee0000000000000000000055', '2026-10-05T09:00:00Z', null, { description: 'Old timer' });
		const { svc } = make(false, fake, { now: T0 });
		await svc.refresh({ force: true, background: true });
		expect(fake.calls).toHaveLength(2);
		expect(svc.current()).toBeNull();
		await svc.refresh({ force: true });
		expect(fake.calls).toHaveLength(4);
		expect(fake.calls.at(-1)?.path).toContain('in-progress=true&page-size=1');
		expect(svc.current()?.description).toBe('Old timer');
	});

	it('start needs GET /user once, then one POST for each start, with no end time', async () => {
		const fake = new FakeClockify();
		const { svc } = make(false, fake, { now: T0 });
		expect(await svc.start({ description: 'Write docs', projectId: PROJ_DOCS, tags: [] })).toBe(true);
		expect(fake.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /user', `POST /workspaces/${WS}/time-entries`]);
		const body = JSON.parse(fake.calls[1]?.body ?? '{}') as Record<string, unknown>;
		expect(body).toEqual({ start: '2026-10-10T08:00:00Z', description: 'Write docs', projectId: PROJ_DOCS });
		expect(svc.current()?.description).toBe('Write docs');
		expect(svc.status()).toBe('running');
	});

	it('stop sends PATCH with the end time to the user path and shows the finished entry', async () => {
		const fake = new FakeClockify();
		const clock = { now: T0 };
		const { svc } = make(false, fake, clock);
		await svc.start({ description: 'A', projectId: null, tags: [] });
		clock.now += 600_000;
		expect(await svc.stop()).toBe(true);
		const last = fake.calls.at(-1);
		expect(last).toMatchObject({ method: 'PATCH', path: entriesPath });
		expect(JSON.parse(last?.body ?? '{}')).toEqual({ end: '2026-10-10T08:10:00Z' });
		expect(svc.current()).toBeNull();
		expect(svc.todaySeconds()).toBe(600);
	});

	it('switch is stop plus start: 2 requests after the ids are known', async () => {
		const fake = new FakeClockify();
		const { svc } = make(false, fake, { now: T0 });
		await svc.start({ description: 'A', projectId: null, tags: [] });
		const before = fake.calls.length;
		await svc.switchTo({ description: 'B', projectId: null, tags: [] });
		expect(fake.calls.slice(before).map((c) => c.method)).toEqual(['PATCH', 'POST']);
		expect(svc.current()?.description).toBe('B');
	});

	it('HTTP 429 with Retry-After blocks every later request until the wait ends, with no new request', async () => {
		const fake = new FakeClockify();
		const clock = { now: T0 };
		const { svc, messages } = make(false, fake, clock);
		fake.mode = '429';
		fake.retryAfter = '90';
		expect(await svc.refresh({ force: true })).toBe(false);
		expect(fake.calls).toHaveLength(1);
		for (let i = 0; i < 5; i++) await svc.refresh({ force: true });
		expect(fake.calls).toHaveLength(1);
		expect(svc.status()).toBe('limited');
		expect(messages.at(-1)).toMatch(/Try again in 2 min/);
		clock.now += 91_001;
		fake.mode = 'ok';
		expect(await svc.refresh({ force: true })).toBe(true);
		expect(fake.calls.slice(1).map((c) => c.path.split('?')[0])).toEqual(['/user', entriesPath, entriesPath]);
	});

	it('HTTP 429 without Retry-After backs off for 1 minute, then 2', async () => {
		const fake = new FakeClockify();
		const clock = { now: T0 };
		const { svc } = make(false, fake, clock);
		fake.mode = '429';
		await svc.refresh({ force: true });
		clock.now += 59_000;
		await svc.refresh({ force: true });
		expect(fake.calls).toHaveLength(1);
		clock.now += 2_000;
		await svc.refresh({ force: true });
		expect(fake.calls).toHaveLength(2);
		clock.now += 119_000;
		await svc.refresh({ force: true });
		expect(fake.calls).toHaveLength(2);
	});

	it('background refresh stops at the reserve, but a tap on a button still sends', async () => {
		const fake = new FakeClockify();
		const clock = { now: T0 };
		const { svc } = make(false, fake, clock);
		await svc.start({ description: 'A', projectId: null, tags: [] });
		svc.deps.client.budget.sent = Array.from({ length: 112 }, () => clock.now);
		expect(svc.requestsLeft()).toBe(8);
		const n = fake.calls.length;
		await svc.refresh({ force: true, background: true });
		await svc.refresh({ force: true, background: true });
		expect(fake.calls.length).toBe(n);
		expect((await svc.deps.client.me()).ok).toBe(true);
		expect(fake.calls.length).toBe(n + 1);
	});

	it('the plugin sends nothing once its own hourly cap of 120 is used, and says when it may send again', async () => {
		const fake = new FakeClockify();
		const clock = { now: T0 };
		const { svc, messages } = make(false, fake, clock);
		svc.deps.client.budget.sent = Array.from({ length: 120 }, () => clock.now - 10 * 60_000);
		expect(await svc.refresh({ force: true })).toBe(false);
		expect(fake.calls).toHaveLength(0);
		expect(svc.status()).toBe('limited');
		expect(messages.at(-1)).toMatch(/Try again in 50 min/);
	});

	it('no connection shows as offline, not as a limit', async () => {
		const fake = new FakeClockify();
		const { svc } = make(false, fake, { now: T0 });
		fake.mode = 'offline';
		await svc.refresh({ force: true });
		expect(svc.status()).toBe('offline');
		fake.mode = '429';
		const again = make(false, fake, { now: T0 + 60_000 });
		await again.svc.refresh({ force: true });
		expect(again.svc.status()).toBe('limited');
	});

	it('a rejected API key says so, sends no retry and is not queued even with Pro', async () => {
		const fake = new FakeClockify();
		const { svc, messages } = make(true, fake, { now: T0 });
		fake.mode = '401';
		expect(await svc.start({ description: 'A', projectId: null, tags: [] })).toBe(false);
		expect(svc.state.queue).toHaveLength(0);
		expect(messages.join(' ')).toMatch(/did not accept the API key/);
	});

	it('an answer to GET /user that is not a user does not crash and is not queued', async () => {
		const calls: string[] = [];
		const http: Http = (r) => {
			calls.push(r.path);
			return Promise.resolve({ status: 200, json: null, headers: {} });
		};
		const messages: string[] = [];
		const client = new ClockifyClient({ getToken: () => 'k', http, now: () => T0, onBudget: () => undefined });
		const svc = new TimerService({ client, now: () => T0, tzOffsetMin: () => 0, isPro: () => true, hasToken: () => true, notify: (m) => messages.push(m), save: () => undefined, ttlMs: () => 600_000, weekStart: () => 1 }, emptyState());
		expect(await svc.start({ description: 'A', projectId: null, tags: [] })).toBe(false);
		expect(svc.state.queue).toHaveLength(0);
		expect(messages.join(' ')).toMatch(/gave no default workspace/);
		expect(calls).toEqual(['/user']);
	});

	it('without Pro an offline start changes nothing and says so', async () => {
		const fake = new FakeClockify();
		fake.mode = 'offline';
		const { svc, messages } = make(false, fake, { now: T0 });
		expect(await svc.start({ description: 'A', projectId: null, tags: [] })).toBe(false);
		expect(svc.state.queue).toHaveLength(0);
		expect(svc.current()).toBeNull();
		expect(messages.join(' ')).toMatch(/Pro keeps a change in a queue/);
	});

	it('with Pro an offline start and stop wait in the queue and replay as ONE request', async () => {
		const fake = new FakeClockify();
		const clock = { now: T0 };
		const { svc } = make(true, fake, clock);
		await svc.refresh();
		await svc.loadTags();
		fake.mode = 'offline';
		fake.calls = [];
		expect(await svc.start({ description: 'Offline work', projectId: PROJ_DOCS, tags: ['x'] })).toBe(true);
		expect(svc.current()?.description).toBe('Offline work');
		clock.now += 15 * 60_000;
		expect(await svc.stop()).toBe(true);
		expect(svc.current()).toBeNull();
		expect(svc.state.queue.map((o) => o.kind)).toEqual(['start', 'stop']);
		expect(svc.pending()).toBe(2);
		fake.mode = 'ok';
		fake.calls = [];
		clock.now += 20 * 60_000;
		expect(await svc.flushQueue()).toBe(1);
		const posts = fake.calls.filter((c) => c.method === 'POST');
		expect(posts).toHaveLength(1);
		expect(JSON.parse(posts[0]?.body ?? '{}')).toEqual({ description: 'Offline work', start: '2026-10-10T08:00:00Z', end: '2026-10-10T08:15:00Z', projectId: PROJ_DOCS, tagIds: [TAG_X] });
		expect(svc.pending()).toBe(0);
	});

	it('with Pro an offline stop of a timer that runs at Clockify replays as one PATCH with the end time of the tap', async () => {
		const fake = new FakeClockify();
		fake.entries = [wireEntry(RUNNING_ID, '2026-10-10T07:00:00Z', null, { description: 'Running' })];
		const clock = { now: T0 };
		const { svc } = make(true, fake, clock);
		await svc.refresh();
		fake.mode = 'offline';
		expect(await svc.stop()).toBe(true);
		fake.mode = 'ok';
		fake.calls = [];
		clock.now += 60 * 60_000;
		await svc.flushQueue();
		const patch = fake.calls.find((c) => c.method === 'PATCH');
		expect(patch?.path).toBe(entriesPath);
		expect(JSON.parse(patch?.body ?? '{}')).toEqual({ end: '2026-10-10T08:00:00Z' });
	});

	it('with Pro a 429 queues the change instead of losing it', async () => {
		const fake = new FakeClockify();
		const { svc } = make(true, fake, { now: T0 });
		await svc.refresh();
		fake.mode = '429';
		expect(await svc.start({ description: 'A', projectId: null, tags: [] })).toBe(true);
		expect(svc.state.queue).toHaveLength(1);
	});

	it('the queue holds at most 40 changes', async () => {
		const fake = new FakeClockify();
		fake.mode = 'offline';
		const clock = { now: T0 };
		const { svc, messages } = make(true, fake, clock);
		for (let i = 0; i < 25; i++) {
			clock.now += 1000;
			await svc.start({ description: `t${i}`, projectId: null, tags: [] });
			clock.now += 1000;
			await svc.stop();
		}
		expect(svc.state.queue).toHaveLength(40);
		expect(messages.some((m) => /queue is full/.test(m))).toBe(true);
	});

	it('without a key no request is sent', async () => {
		const fake = new FakeClockify();
		const { svc, messages } = make(false, fake, { now: T0 }, null);
		expect(await svc.start({ description: 'A', projectId: null, tags: [] })).toBe(false);
		expect(await svc.refresh({ force: true })).toBe(false);
		expect(fake.calls).toHaveLength(0);
		expect(svc.status()).toBe('nolink');
		expect(messages[0]).toMatch(/API key/);
	});

	it('the key goes in the X-Api-Key header only and appears nowhere in the saved state or in messages', async () => {
		const fake = new FakeClockify();
		const { svc, messages } = make(false, fake, { now: T0 }, 'secret-key-123');
		await svc.start({ description: 'A', projectId: null, tags: [] });
		fake.mode = '401';
		await svc.refresh({ force: true });
		expect(fake.calls[0]?.headers['X-Api-Key']).toBe('secret-key-123');
		expect(fake.calls[0]?.headers.Authorization).toBeUndefined();
		expect(fake.calls.map((c) => c.path).join(' ')).not.toContain('secret-key-123');
		expect(JSON.stringify(svc.state)).not.toContain('secret-key-123');
		expect(messages.join(' ')).not.toContain('secret-key-123');
	});

	it('the report asks once for a range and uses the copy for 15 minutes', async () => {
		const fake = new FakeClockify();
		fake.entries = [
			wireEntry('ee0000000000000000000001', '2026-10-08T06:00:00Z', '2026-10-08T07:00:00Z', { description: 'a', projectId: PROJ_DOCS, project: { name: 'Docs', color: '#111111' } }),
			wireEntry('ee0000000000000000000002', '2026-10-09T06:00:00Z', '2026-10-09T06:30:00Z', { description: 'b', projectId: PROJ_CODE, project: { name: 'Code', color: '#222222' } }),
		];
		const clock = { now: T0 };
		const { svc } = make(true, fake, clock);
		const r = await svc.report({ range: 'week', by: 'project' });
		expect(r).toMatchObject({ totalSeconds: 5400, label: 'week of 2026-10-05' });
		expect('rows' in r && r.rows.map((x) => x.key)).toEqual(['Docs', 'Code']);
		await svc.report({ range: 'week', by: 'day' });
		expect(fake.calls).toHaveLength(2);
		clock.now += 16 * 60_000;
		await svc.report({ range: 'week', by: 'day' });
		expect(fake.calls).toHaveLength(3);
		expect(await svc.report({ range: 'sometime', by: 'day' })).toHaveProperty('error');
	});

	it('two report blocks for one range at the same time cost one request, and three manual refreshes at once cost one refresh (2 requests)', async () => {
		const fake = new FakeClockify();
		const { svc } = make(true, fake, { now: T0 });
		const [a, b] = await Promise.all([svc.report({ range: 'week', by: 'project' }), svc.report({ range: 'week', by: 'day' })]);
		expect('rows' in a && 'rows' in b).toBe(true);
		expect(fake.calls.map((c) => c.path.split('?')[0])).toEqual(['/user', entriesPath]);
		fake.calls = [];
		await Promise.all([svc.refresh({ force: true }), svc.refresh({ force: true }), svc.refresh({ force: true })]);
		expect(fake.calls).toHaveLength(2);
	});

	it('edit sends PUT with the project, tags and billable flag again, and delete sends DELETE', async () => {
		const fake = new FakeClockify();
		fake.entries = [wireEntry(ID9, '2026-10-10T06:00:00Z', '2026-10-10T07:00:00Z', { description: 'Old', billable: true, tagIds: [TAG_X], projectId: PROJ_CODE })];
		const { svc } = make(true, fake, { now: T0 });
		await svc.refresh();
		expect(await svc.editEntry(ID9, { description: 'New', projectId: PROJ_DOCS, startMs: Date.parse('2026-10-10T06:00:00Z'), stopMs: Date.parse('2026-10-10T06:30:00Z') })).toBe(true);
		const put = fake.calls.at(-1);
		expect(put).toMatchObject({ method: 'PUT', path: `/workspaces/${WS}/time-entries/${ID9}` });
		expect(JSON.parse(put?.body ?? '{}')).toEqual({ start: '2026-10-10T06:00:00Z', end: '2026-10-10T06:30:00Z', description: 'New', projectId: PROJ_DOCS, tagIds: [TAG_X], billable: true });
		expect(svc.todaySeconds()).toBe(1800);
		expect(await svc.deleteEntry(ID9)).toBe(true);
		expect(fake.calls.at(-1)).toMatchObject({ method: 'DELETE', path: `/workspaces/${WS}/time-entries/${ID9}` });
		expect(svc.state.entries).toHaveLength(0);
	});

	it('projects and tags load once per 6 hours; tag names become ids and an unknown tag is left out; the new timer carries the project name', async () => {
		const fake = new FakeClockify();
		const clock = { now: T0 };
		const { svc } = make(true, fake, clock);
		const projects = await svc.loadProjects();
		expect(projects.map((p) => p.name)).toEqual(['Docs', 'Code']);
		expect(fake.calls.at(-1)?.path).toBe(`/workspaces/${WS}/projects?archived=false&page-size=500`);
		await svc.loadProjects();
		await svc.loadTags();
		await svc.loadTags();
		expect(fake.calls.map((c) => c.path.split('?')[0])).toEqual(['/user', `/workspaces/${WS}/projects`, `/workspaces/${WS}/tags`]);
		await svc.start({ description: 'T', projectId: PROJ_DOCS, tags: ['X', 'nope'] });
		const post = fake.calls.find((c) => c.method === 'POST');
		expect(JSON.parse(post?.body ?? '{}')).toMatchObject({ tagIds: [TAG_X] });
		expect(svc.current()).toMatchObject({ project_name: 'Docs', project_color: '#03A9F4' });
		clock.now += 7 * 3_600_000;
		await svc.loadProjects();
		expect(fake.calls.filter((c) => c.path.includes('/projects'))).toHaveLength(2);
	});

	it('a report counts each entry that Clockify sends, up to the 2,000 of the README, not only the first 1,000', async () => {
		const fake = new FakeClockify();
		const base = Date.parse('2026-10-06T00:00:00Z');
		fake.entries = Array.from({ length: 1500 }, (_, i) => wireEntry(`ee${i.toString(16).padStart(22, '0')}`, new Date(base + i * 120_000).toISOString(), new Date(base + i * 120_000 + 60_000).toISOString()));
		const { svc } = make(true, fake, { now: T0 });
		const r = await svc.report({ range: 'week', by: 'project' });
		expect(r).toMatchObject({ totalSeconds: 1500 * 60 });
	});

	it('with Pro a note project from its property is found when the project list is not loaded yet', async () => {
		const fake = new FakeClockify();
		const { svc } = make(true, fake, { now: T0 });
		expect(svc.state.projects).toEqual([]);
		expect(await svc.projectIdFor('Code')).toBe(PROJ_CODE);
		expect(await svc.projectIdFor('code')).toBe(PROJ_CODE);
		const n = fake.calls.length;
		expect(await svc.projectIdFor('No such project')).toBeNull();
		expect(await svc.projectIdFor(null)).toBeNull();
		expect(fake.calls).toHaveLength(n);
		await Promise.all([svc.loadProjects(true), svc.loadProjects(true)]);
		expect(fake.calls).toHaveLength(n + 1);
	});
});

describe('paged lists', () => {
	const pager = (lastAt: number): { http: Http; pages: string[] } => {
		const pages: string[] = [];
		const http: Http = (r) => {
			const page = Number(/page=(\d+)/.exec(r.path)?.[1] ?? '1');
			pages.push(String(page));
			return Promise.resolve({ status: 200, json: [{ n: page }], headers: { 'Last-Page': page >= lastAt ? 'true' : 'false' } });
		};
		return { http, pages };
	};
	it('a report follows the Last-Page header', async () => {
		const p = pager(2);
		const client = new ClockifyClient({ getToken: () => 'k', http: p.http, now: () => T0, onBudget: () => undefined });
		const r = await client.entriesAll(WS, UID, T0 - 86_400_000, T0);
		expect(r.ok && r.data).toEqual([{ n: 1 }, { n: 2 }]);
		expect(p.pages).toEqual(['1', '2']);
	});
	it('a report never asks for more than the page limit', async () => {
		const p = pager(99);
		const client = new ClockifyClient({ getToken: () => 'k', http: p.http, now: () => T0, onBudget: () => undefined });
		await client.entriesAll(WS, UID, T0 - 86_400_000, T0);
		expect(p.pages).toHaveLength(MAX_PAGES);
	});
	it('a report reads at most 2,000 entries, the number in the README', () => {
		expect(PAGE_SIZE * MAX_PAGES).toBe(2000);
	});
});

describe('normalizeState', () => {
	it('repairs junk', () => {
		const s = normalizeState({ workspaceId: 5, entries: [1, { id: 'a' }, { id: 'b', start: 'bad' }], queue: [{ kind: 'zap' }, { kind: 'stop', atMs: 5 }], budget: 7, nextTempId: -3, projects: [{ id: 1 }], tags: [{ id: 3 }, 'x'] });
		expect(s.workspaceId).toBeNull();
		expect(s.entries).toEqual([]);
		expect(s.queue).toEqual([{ kind: 'stop', atMs: 5 }]);
		expect(s.projects).toEqual([]);
		expect(s.tags).toEqual([]);
		expect(s.nextTempId).toBe(1);
		expect(s.budget.sent).toEqual([]);
	});
	it('round trips a saved state', () => {
		const s = emptyState();
		s.workspaceId = WS;
		s.userId = UID;
		s.tags = [{ id: TAG_X, name: 'x' }];
		s.queue = [{ kind: 'start', atMs: 1, description: 'x', projectId: PROJ_DOCS, tags: [TAG_X] }];
		expect(normalizeState(JSON.parse(JSON.stringify(s)))).toEqual(s);
	});
});

describe('ids in the URL path', () => {
	it('an id that is not 24 hex digits sends no request and does not throw', async () => {
		const fake = new FakeClockify();
		const { client } = make(false, fake, { now: T0 });
		const bad = [
			await client.stop('', UID, {}),
			await client.stop(WS, 'x', {}),
			await client.update(WS, '../x', {}),
			await client.update(WS, 'local-1', {}),
			await client.remove('nan', ID9),
			await client.create('0', {}),
			await client.entries(WS, '', 0, 1, false),
			await client.current('', UID),
		];
		for (const r of bad) expect(r).toMatchObject({ ok: false, kind: 'http' });
		expect(fake.calls).toHaveLength(0);
	});
});
