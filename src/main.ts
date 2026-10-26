import { Notice, Platform, Plugin, TFile, type Editor, type WorkspaceLeaf } from 'obsidian';
import type { SponsorsManager } from './license/index';
import { createGitHubSponsors } from './license/github-obsidian';
import { ClockifyClient, obsidianHttp } from './client';
import { entrySeconds, formatClock, formatHours, formatWait, noteDescription, noteProjectRef, taskDescription } from './logic';
import { EditModal, StartModal } from './modals';
import { SPONSORS, bindPro, isPro, resetPro, proNotice } from './pro';
import { renderReport } from './report';
import { TimerService, emptyState, normalizeState } from './service';
import { DEFAULT_SETTINGS, ClockifyMobileTimerSettingTab, normalizeSettings, type ClockifyMobileTimerSettings } from './settings';
import { TimerView, VIEW_ID } from './view';
import type { TimeEntry } from './logic';
import { setupHello } from './hello/index';
import WHATS_NEW from './whats-new.json';

/** How often to ask the license state whether a check is due. It sends a request only when signed in and due (7 days). */
const PRO_TICK_MS = 6 * 60 * 60 * 1000;
/** Wait before data.json is written after a change, so a burst of changes is one write. */
const SAVE_DELAY_MS = 400;

interface SavedData {
	settings?: Partial<ClockifyMobileTimerSettings>;
	state?: unknown;
}

export default class ClockifyMobileTimerPlugin extends Plugin {
	settings: ClockifyMobileTimerSettings = { ...DEFAULT_SETTINGS };
	/** GitHub Sponsors Pro state. Created in onload; null before that. */
	pro: SponsorsManager | null = null;
	service: TimerService = this.makeService(emptyState());
	private settingTab: ClockifyMobileTimerSettingTab | null = null;
	private statusEl: HTMLElement | null = null;
	private ribbonEl: HTMLElement | null = null;
	private saveTimer: number | null = null;

	async onload(): Promise<void> {
		// First: "What's new" reads its state before the settings load (packages/hello). It does not wait.
		setupHello(this, WHATS_NEW);
		const saved = ((await this.loadData()) as SavedData | null) ?? {};
		this.settings = normalizeSettings(saved.settings);
		this.service = this.makeService(normalizeState(saved.state));
		// No request here: a request needs a GitHub sign in first (Settings, Pro, Sign in with GitHub).
		const pro = createGitHubSponsors(this.app, this.manifest.id, SPONSORS, this);
		pro.init();
		this.pro = pro;
		bindPro(pro);
		this.settingTab = new ClockifyMobileTimerSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);
		this.register(pro.onChange(() => this.onProChange()));
		this.register(this.service.onChange(() => this.refreshChrome()));
		this.registerView(VIEW_ID, (leaf) => new TimerView(leaf, this));
		this.ribbonEl = this.addRibbonIcon('timer', 'Clockify timer: start or stop', () => this.toggle());
		this.addCommands();
		this.registerMarkdownCodeBlockProcessor('clockify-report', (source, el, ctx) => renderReport(this, source, el, ctx));
		this.registerEvents();
		this.app.workspace.onLayoutReady(() => {
			this.refreshChrome();
			void this.service.refresh({ background: true });
			void pro.refresh();
			this.registerInterval(window.setInterval(() => void pro.refresh(), PRO_TICK_MS));
			this.registerInterval(window.setInterval(() => this.tick(), 1000));
		});
	}

	onunload(): void {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		void this.saveNow();
		resetPro();
	}

	private makeService(state: ReturnType<typeof emptyState>): TimerService {
		const client = new ClockifyClient({ getToken: () => this.token(), http: obsidianHttp, now: () => Date.now(), onBudget: () => this.scheduleSave() });
		return new TimerService(
			{
				client,
				now: () => Date.now(),
				tzOffsetMin: () => -new Date().getTimezoneOffset(),
				isPro: () => isPro(),
				hasToken: () => this.token() !== null,
				notify: (m) => new Notice(m),
				save: () => this.scheduleSave(),
				ttlMs: () => this.settings.refreshMinutes * 60_000,
				weekStart: () => (this.settings.weekStart === 'sunday' ? 0 : 1),
			},
			state,
		);
	}

	/** The API token from Obsidian secret storage. It is read for each request and never kept or logged. */
	private token(): string | null {
		try {
			const t = this.app.secretStorage.getSecret(this.settings.tokenSecretId);
			return t && t.trim() ? t.trim() : null;
		} catch {
			return null;
		}
	}

	// ------------------------------------------------------------ saving

	private scheduleSave(): void {
		if (this.saveTimer !== null) return;
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.saveNow();
		}, SAVE_DELAY_MS);
	}

	private async saveNow(): Promise<void> {
		await this.saveData({ settings: this.settings, state: this.service.state });
	}

	async persist(): Promise<void> {
		await this.saveNow();
	}

	// ------------------------------------------------------------ commands, events

	private addCommands(): void {
		this.addCommand({ id: 'start', name: 'Start timer', callback: () => this.openStart('Start timer') });
		this.addCommand({ id: 'start-note', name: 'Start timer for this note', checkCallback: (c) => this.startForNote(c) });
		this.addCommand({ id: 'start-task', name: 'Start timer for this task', editorCheckCallback: (c, editor, ctx) => this.startForTask(c, editor, ctx.file) });
		this.addCommand({ id: 'stop', name: 'Stop timer', callback: () => void this.service.stop() });
		this.addCommand({ id: 'switch', name: 'Switch timer', callback: () => this.openStart('Switch timer') });
		this.addCommand({ id: 'toggle', name: 'Start or stop timer', callback: () => this.toggle() });
		this.addCommand({ id: 'refresh', name: 'Refresh timer', callback: () => void this.service.refresh({ force: true }) });
		this.addCommand({ id: 'open-panel', name: 'Open timer panel', callback: () => void this.openPanel() });
		this.addCommand({ id: 'send-queue', name: 'Send queued changes', callback: () => this.sendQueue() });
	}

	private registerEvents(): void {
		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu, editor, info) => {
				if (!taskDescription(editor.getLine(editor.getCursor().line))) return;
				menu.addItem((item) => item.setTitle('Start timer for this task').setIcon('timer').onClick(() => this.startForTask(false, editor, info.file)));
			}),
		);
		// A phone suspends the app: the elapsed time is derived from the start time on Clockify, and the data is refreshed
		// only when the cache is older than the refresh setting.
		this.registerDomEvent(document, 'visibilitychange', () => {
			if (document.visibilityState === 'visible') void this.service.refresh({ background: true });
		});
		this.registerDomEvent(window, 'online', () => void this.service.refresh({ force: true, background: true }));
		this.registerDomEvent(window, 'offline', () => this.refreshChrome());
	}

	private sendQueue(): void {
		if (!isPro()) {
			this.needsPro('The offline queue');
			return;
		}
		void this.service.flushQueue();
	}

	needsPro(feature: string): void {
		proNotice(`${feature} is a pro feature.`);
	}

	private onProChange(): void {
		this.settingTab?.update();
		this.refreshChrome();
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_ID)) if (leaf.view instanceof TimerView) leaf.view.render();
		if (isPro()) void this.service.flushQueue();
	}

	// ------------------------------------------------------------ actions

	toggle(): void {
		if (this.service.current()) void this.service.stop();
		else this.openStart('Start timer');
	}

	/** The project for a timer that starts from a note: Pro property "clockify-project", else the default project. */
	async projectForNote(file: TFile | null): Promise<string | null> {
		if (file && isPro()) {
			const id = await this.service.projectIdFor(noteProjectRef(this.app.metadataCache.getFileCache(file)?.frontmatter));
			if (id !== null) return id;
		}
		return this.defaultProjectId();
	}

	private defaultProjectId(): string | null {
		return this.settings.defaultProjectId === '' ? null : this.settings.defaultProjectId;
	}

	private startForNote(checking: boolean): boolean {
		const file = this.app.workspace.getActiveFile();
		if (!file) return false;
		if (!checking) {
			const description = noteDescription(file.basename, this.settings.useNoteTitle);
			void this.projectForNote(file).then((projectId) => this.service.start({ description, projectId, tags: [] }));
		}
		return true;
	}

	/** Starts a timer with the line at the cursor as the description. A running timer stops first. A line with no text does nothing. */
	private startForTask(checking: boolean, editor: Editor, file: TFile | null): boolean {
		const description = taskDescription(editor.getLine(editor.getCursor().line));
		if (!description) return false;
		if (!checking) void this.projectForNote(file).then((projectId) => this.service.start({ description, projectId, tags: [] }));
		return true;
	}

	openStart(title: string): void {
		void this.openStartAsync(title);
	}

	/** With Pro the project and tag lists load (cached for 6 hours). The window waits for them only when no project list is saved yet. */
	private async openStartAsync(title: string): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		const svc = this.service;
		if (isPro()) {
			const lists = Promise.all([svc.loadProjects(), svc.loadTags()]);
			if (svc.state.projects.length === 0) await lists;
		}
		const projectId = await this.projectForNote(file);
		const def = svc.state.projects.find((p) => p.id === this.defaultProjectId());
		new StartModal(this.app, {
			title,
			description: noteDescription(file?.basename, this.settings.useNoteTitle),
			projects: svc.state.projects,
			projectId,
			defaultProjectName: def?.name ?? '',
			tagNames: svc.state.tags.map((t) => t.name),
			onSubmit: (req) => void (title === 'Switch timer' ? svc.switchTo(req) : svc.start(req)),
		}).open();
	}

	editEntry(e: TimeEntry): void {
		if (!isPro()) {
			this.needsPro('Editing entries');
			return;
		}
		void this.service.loadProjects().then((projects) => {
			new EditModal(
				this.app,
				e,
				projects,
				(r) => void this.service.editEntry(e.id, r),
				() => void this.service.deleteEntry(e.id),
			).open();
		});
	}

	async checkConnection(): Promise<void> {
		const r = await this.service.deps.client.me();
		new Notice(r.ok ? `Connected to Clockify as ${r.data.name}.` : r.message);
		if (r.ok) {
			this.service.state.workspaceId = r.data.defaultWorkspace;
			this.service.state.userId = r.data.id;
			this.scheduleSave();
		}
	}

	async openPanel(): Promise<void> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_ID)[0] ?? null;
		if (!leaf) {
			leaf = Platform.isMobile ? workspace.getLeaf('tab') : workspace.getRightLeaf(false);
			await leaf?.setViewState({ type: VIEW_ID, active: true });
		}
		if (leaf) await workspace.revealLeaf(leaf);
	}

	// ------------------------------------------------------------ chrome: status bar, ribbon, tick

	/** Text of the pill: the running timer, or the reason there is none. */
	pillText(): string {
		const svc = this.service;
		const status = svc.status();
		if (status === 'nolink') return 'Add your Clockify API key in settings';
		if (status === 'limited') return `Request limit reached, retry in ${formatWait(svc.waitMs())}`;
		const run = svc.current();
		if (!run) return status === 'offline' ? 'Offline, no timer' : 'No timer running';
		const proj = run.project_name ? `${run.project_name}: ` : '';
		return `${proj}${run.description || '(no description)'}`;
	}

	refreshChrome(): void {
		const svc = this.service;
		const run = svc.current();
		const want = Platform.isDesktop && this.settings.showStatusBar;
		if (want && !this.statusEl) {
			this.statusEl = this.addStatusBarItem();
			this.statusEl.addClass('tmt-status');
			this.statusEl.addEventListener('click', () => void this.openPanel());
		}
		if (!want && this.statusEl) {
			this.statusEl.remove();
			this.statusEl = null;
		}
		this.ribbonEl?.toggleClass('tmt-ribbon-running', run !== null);
		this.ribbonEl?.setAttribute('aria-label', run ? 'Stop Clockify timer' : 'Start Clockify timer');
		this.tick();
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_ID)) if (leaf.view instanceof TimerView) leaf.view.render();
	}

	/** Each second while the app is visible: clock and day total from the start time on Clockify. No request. */
	tick(): void {
		if (document.hidden) return;
		const svc = this.service;
		const run = svc.current();
		if (this.statusEl) {
			const clock = run ? `${formatClock(entrySeconds(run, this.service.deps.now()))} ` : '';
			this.statusEl.setText(`${run ? '● ' : ''}${clock}${this.pillText().slice(0, 40)} | ${formatHours(svc.todaySeconds())}`);
			this.statusEl.setAttribute('aria-label', 'Clockify timer. Select to open the timer panel.');
		}
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_ID)) if (leaf.view instanceof TimerView) leaf.view.tick();
	}
}
