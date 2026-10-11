// Timer service: the state, the cache and the actions. It has no Obsidian import: the plugin gives it a client,
// a clock and a few callbacks, so vitest runs it against a fake Clockify.
import { RETRYABLE, validId, type ClockifyClient, type Reply } from './client';
import {
	APP_NAME,
	LOCAL_PREFIX,
	createBody,
	dayBounds,
	entrySeconds,
	groupSeconds,
	isRunning,
	isStale,
	isoSeconds,
	newBudget,
	planReplay,
	rangeFor,
	remainingNow,
	enqueue,
	fromWire,
	isLocalId,
	stopBody,
	tagIdsFor,
	totalSeconds,
	type Budget,
	type GroupBy,
	type GroupRow,
	type PlanStep,
	type Project,
	type QueueOp,
	type ServerTimer,
	type Tag,
	type TimeEntry,
} from './logic';

const DAY_MS = 86_400_000;
const MAX_ENTRIES = 300;
const REPORT_TTL_MS = 15 * 60_000;
/** Projects and tags change rarely: one request each per 6 hours. */
const LIST_TTL_MS = 6 * 3_600_000;

export interface TimerState {
	workspaceId: string | null;
	userId: string | null;
	projects: Project[];
	projectsAt: number | null;
	tags: Tag[];
	tagsAt: number | null;
	entries: TimeEntry[];
	entriesAt: number | null;
	queue: QueueOp[];
	queueBase: ServerTimer | null;
	plan: PlanStep[];
	budget: Budget;
	/** Counts up. The next waiting entry gets the id local-N. */
	nextTempId: number;
}

export function emptyState(): TimerState {
	return { workspaceId: null, userId: null, projects: [], projectsAt: null, tags: [], tagsAt: null, entries: [], entriesAt: null, queue: [], queueBase: null, plan: [], budget: newBudget(), nextTempId: 1 };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const textOrNull = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** One entry from Clockify (fromWire) or from data.json (the plugin shape), cut to the fields we use. Null for anything else. */
export function cleanEntry(v: unknown): TimeEntry | null {
	if (isObj(v) && isObj(v.timeInterval)) return fromWire(v);
	if (!isObj(v) || typeof v.id !== 'string' || v.id === '' || typeof v.start !== 'string' || !Number.isFinite(Date.parse(v.start))) return null;
	return {
		id: v.id,
		workspace_id: textOrNull(v.workspace_id) ?? '',
		description: typeof v.description === 'string' ? v.description : null,
		start: v.start,
		stop: typeof v.stop === 'string' ? v.stop : null,
		duration: numOrNull(v.duration) ?? -1,
		project_id: textOrNull(v.project_id),
		project_name: typeof v.project_name === 'string' ? v.project_name : null,
		project_color: typeof v.project_color === 'string' ? v.project_color : null,
		tags: Array.isArray(v.tags) ? v.tags.filter((t): t is string => typeof t === 'string').slice(0, 10) : null,
		task_id: textOrNull(v.task_id),
		billable: v.billable === true,
	};
}

function cleanList<T>(raw: unknown, one: (v: unknown) => T | null, max: number): T[] {
	if (!Array.isArray(raw)) return [];
	const out: T[] = [];
	for (const v of raw.slice(0, max)) {
		const c = one(v);
		if (c !== null) out.push(c);
	}
	return out;
}

/** A project from Clockify (workspaceId, archived) or from data.json (workspace_id, active). */
function cleanProject(v: unknown): Project | null {
	if (!isObj(v) || typeof v.id !== 'string' || v.id === '' || typeof v.name !== 'string') return null;
	const color = typeof v.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v.color) ? v.color : '#888888';
	return { id: v.id, workspace_id: textOrNull(v.workspaceId) ?? textOrNull(v.workspace_id) ?? '', name: v.name, color, active: v.active !== false && v.archived !== true };
}

function cleanTag(v: unknown): Tag | null {
	return isObj(v) && typeof v.id === 'string' && v.id !== '' && typeof v.name === 'string' ? { id: v.id, name: v.name } : null;
}

function cleanOp(v: unknown): QueueOp | null {
	if (!isObj(v) || typeof v.atMs !== 'number') return null;
	if (v.kind === 'stop') return { kind: 'stop', atMs: v.atMs };
	if (v.kind !== 'start') return null;
	const tags = Array.isArray(v.tags) ? v.tags.filter((t): t is string => typeof t === 'string') : [];
	return { kind: 'start', atMs: v.atMs, description: typeof v.description === 'string' ? v.description : '', projectId: textOrNull(v.projectId), tags };
}

function cleanBudget(v: unknown): Budget {
	if (!isObj(v)) return newBudget();
	const sent = Array.isArray(v.sent) ? v.sent.filter((t): t is number => typeof t === 'number').slice(-200) : [];
	return { blockedUntilMs: numOrNull(v.blockedUntilMs) ?? 0, failures: numOrNull(v.failures) ?? 0, sent };
}

/** Repairs saved state, so a hand-edited or old data.json never breaks the plugin. */
export function normalizeState(raw: unknown): TimerState {
	const s = emptyState();
	if (!isObj(raw)) return s;
	s.workspaceId = textOrNull(raw.workspaceId);
	s.userId = textOrNull(raw.userId);
	s.projects = cleanList(raw.projects, cleanProject, 500);
	s.projectsAt = numOrNull(raw.projectsAt);
	s.tags = cleanList(raw.tags, cleanTag, 500);
	s.tagsAt = numOrNull(raw.tagsAt);
	s.entries = cleanList(raw.entries, cleanEntry, MAX_ENTRIES);
	s.entriesAt = numOrNull(raw.entriesAt);
	s.queue = cleanList(raw.queue, cleanOp, 40);
	const b = isObj(raw.queueBase) ? raw.queueBase : null;
	s.queueBase = b && typeof b.id === 'string' && typeof b.workspaceId === 'string' && typeof b.startMs === 'number' ? { id: b.id, workspaceId: b.workspaceId, startMs: b.startMs } : null;
	s.plan = Array.isArray(raw.plan) ? (raw.plan.filter((p) => isObj(p) && (p.step === 'create' || p.step === 'stop')) as unknown as PlanStep[]).slice(0, 40) : [];
	s.budget = cleanBudget(raw.budget);
	s.nextTempId = Math.max(1, numOrNull(raw.nextTempId) ?? 1);
	return s;
}

export interface ServiceDeps {
	client: ClockifyClient;
	now: () => number;
	/** Minutes east of UTC. */
	tzOffsetMin: () => number;
	isPro: () => boolean;
	hasToken: () => boolean;
	notify: (message: string) => void;
	save: () => void;
	ttlMs: () => number;
	weekStart: () => number;
}

export interface StartRequest {
	description: string;
	projectId: string | null;
	/** Tag names as typed. The service turns them into tag ids. */
	tags: string[];
}

export type Status = 'nolink' | 'offline' | 'limited' | 'running' | 'idle';

export interface Report {
	label: string;
	by: GroupBy;
	rows: GroupRow[];
	totalSeconds: number;
	updatedAt: number;
	stale: boolean;
}

export class TimerService {
	state: TimerState;
	deps: ServiceDeps;
	private listeners = new Set<() => void>();
	private offline = false;
	private flushing = false;
	private reports = new Map<string, { entries: TimeEntry[]; at: number }>();
	/** Requests that are on their way, by range. A second report block for the same range waits for the first answer. */
	private inflight = new Map<string, Promise<Reply<unknown[]>>>();
	private refreshing: Promise<boolean> | null = null;

	constructor(deps: ServiceDeps, state: TimerState) {
		this.deps = deps;
		this.state = state;
		deps.client.budget = state.budget;
	}

	onChange(cb: () => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	private changed(): void {
		this.deps.save();
		for (const cb of [...this.listeners]) cb();
	}

	// ------------------------------------------------------------ reading

	current(): TimeEntry | null {
		return this.state.entries.find((e) => isRunning(e)) ?? null;
	}

	todaySeconds(): number {
		const now = this.deps.now();
		const day = dayBounds(now, this.deps.tzOffsetMin());
		return totalSeconds(this.state.entries, now, day.fromMs, day.toMs);
	}

	/** Entries that overlap today, newest first. */
	todayEntries(): TimeEntry[] {
		const now = this.deps.now();
		const day = dayBounds(now, this.deps.tzOffsetMin());
		const hit = this.state.entries.filter((e) => {
			const start = Date.parse(e.start);
			return start < day.toMs && start + entrySeconds(e, now) * 1000 > day.fromMs;
		});
		return hit.sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
	}

	status(): Status {
		if (!this.deps.hasToken()) return 'nolink';
		// No connection comes first: its short retry wait is not a Clockify limit.
		if (this.offline) return 'offline';
		const now = this.deps.now();
		const b = this.deps.client.budget;
		if (now < b.blockedUntilMs || remainingNow(b, now) <= 0) return 'limited';
		return this.current() ? 'running' : 'idle';
	}

	/** Requests left in the plugin's own hourly cap, for the settings page and the panel. */
	requestsLeft(): number {
		return Math.max(0, remainingNow(this.deps.client.budget, this.deps.now()));
	}

	/** Wait in ms until the plugin sends requests again, or 0. */
	waitMs(): number {
		return Math.max(0, this.deps.client.budget.blockedUntilMs - this.deps.now());
	}

	// ------------------------------------------------------------ requests

	private fail(r: Extract<Reply<unknown>, { ok: false }>, quiet: boolean): void {
		this.offline = r.kind === 'offline';
		if (!quiet) this.deps.notify(r.message);
		this.changed();
	}

	/** The workspace and user ids. The first call asks Clockify (1 request); later calls read the saved ids. */
	private async identity(): Promise<Reply<{ ws: string; uid: string }>> {
		if (this.state.workspaceId !== null && this.state.userId !== null) return { ok: true, status: 200, data: { ws: this.state.workspaceId, uid: this.state.userId }, lastPage: true };
		const r = await this.deps.client.me();
		if (!r.ok) return r;
		const me: unknown = r.data;
		const ws = isObj(me) && typeof me.defaultWorkspace === 'string' ? me.defaultWorkspace : '';
		const uid = isObj(me) && typeof me.id === 'string' ? me.id : '';
		if (!validId(ws) || !validId(uid)) return { ok: false, kind: 'http', status: r.status, waitMs: 0, message: 'Clockify gave no default workspace.' };
		this.state.workspaceId = ws;
		this.state.userId = uid;
		return { ok: true, status: r.status, data: { ws, uid }, lastPage: true };
	}

	/** One request: entries of yesterday and today give the running timer and the day total. Skipped when the cache is fresh. */
	refresh(opts: { force?: boolean; background?: boolean } = {}): Promise<boolean> {
		// A refresh that is on its way answers a second call too: layout ready, a return to the app and a button can come together.
		if (this.refreshing) return this.refreshing;
		const run = this.refreshOnce(opts).finally(() => {
			this.refreshing = null;
		});
		this.refreshing = run;
		return run;
	}

	private async refreshOnce(opts: { force?: boolean; background?: boolean }): Promise<boolean> {
		const now = this.deps.now();
		const tz = this.deps.tzOffsetMin();
		if (!this.deps.hasToken()) return false;
		if (this.deps.isPro() && (this.state.queue.length > 0 || this.state.plan.length > 0)) {
			await this.flushQueue();
			if (this.state.queue.length > 0 || this.state.plan.length > 0) return false;
		}
		if (!opts.force && !isStale(this.state.entriesAt, now, this.deps.ttlMs(), tz)) return true;
		const day = dayBounds(now, tz);
		const who = await this.identity();
		if (!who.ok) {
			this.fail(who, opts.background === true);
			return false;
		}
		const r = await this.deps.client.entries(who.data.ws, who.data.uid, day.fromMs - DAY_MS, day.toMs, opts.background === true);
		if (!r.ok) {
			this.fail(r, opts.background === true);
			return false;
		}
		this.offline = false;
		this.state.entries = cleanList(r.data, cleanEntry, MAX_ENTRIES);
		this.state.entriesAt = now;
		// A manual refresh (not a background one) also asks for the running timer, so a timer from before yesterday shows. 1 more request.
		if (opts.force === true && opts.background !== true) await this.checkCurrent();
		this.changed();
		return true;
	}

	private async checkCurrent(): Promise<void> {
		const who = await this.identity();
		if (!who.ok) return;
		const r = await this.deps.client.current(who.data.ws, who.data.uid);
		if (!r.ok) return;
		const e = cleanEntry(r.data);
		if (e && isRunning(e)) this.applyEntry(e);
	}

	async loadProjects(force = false): Promise<Project[]> {
		const now = this.deps.now();
		if (!force && this.state.projectsAt !== null && now - this.state.projectsAt < LIST_TTL_MS) return this.state.projects;
		const who = await this.identity();
		if (!who.ok) {
			this.fail(who, true);
			return this.state.projects;
		}
		const r = await this.deps.client.projects(who.data.ws);
		if (!r.ok) {
			this.fail(r, true);
			return this.state.projects;
		}
		this.state.projects = cleanList(r.data, cleanProject, 500);
		this.state.projectsAt = now;
		this.changed();
		return this.state.projects;
	}

	async loadTags(force = false): Promise<Tag[]> {
		const now = this.deps.now();
		if (!force && this.state.tagsAt !== null && now - this.state.tagsAt < LIST_TTL_MS) return this.state.tags;
		const who = await this.identity();
		if (!who.ok) {
			this.fail(who, true);
			return this.state.tags;
		}
		const r = await this.deps.client.tags(who.data.ws);
		if (!r.ok) {
			this.fail(r, true);
			return this.state.tags;
		}
		this.state.tags = cleanList(r.data, cleanTag, 500);
		this.state.tagsAt = now;
		this.changed();
		return this.state.tags;
	}

	// ------------------------------------------------------------ start, stop, switch

	private applyEntry(e: unknown): void {
		const entry = cleanEntry(e);
		if (!entry) return;
		this.addProjectName(entry);
		const list = this.state.entries.filter((x) => x.id !== entry.id);
		if (isRunning(entry)) for (const x of list) if (isRunning(x)) this.closeLocal(x, Date.parse(entry.start));
		list.push(entry);
		this.state.entries = list.slice(-MAX_ENTRIES);
		this.offline = false;
		this.changed();
	}

	/** A create or stop answer has the project id but not its name or color: take them from the saved projects. */
	private addProjectName(entry: TimeEntry): void {
		if (entry.project_id === null || entry.project_name) return;
		const known = this.state.entries.find((x) => x.id === entry.id && x.project_id === entry.project_id && x.project_name) ?? null;
		const p = this.state.projects.find((x) => x.id === entry.project_id) ?? null;
		entry.project_name = p?.name ?? known?.project_name ?? null;
		entry.project_color = p?.color ?? known?.project_color ?? null;
	}

	private closeLocal(e: TimeEntry, stopMs: number): void {
		e.stop = isoSeconds(stopMs);
		e.duration = Math.max(0, Math.round((stopMs - Date.parse(e.start)) / 1000));
	}

	async start(req: StartRequest): Promise<boolean> {
		if (!this.deps.hasToken()) {
			this.deps.notify('Add your Clockify API key in the plugin settings.');
			return false;
		}
		const running = this.current();
		if (running && !(await this.stop())) return false;
		const startMs = this.deps.now();
		const tagIds = tagIdsFor(req.tags, this.state.tags);
		const op: QueueOp = { kind: 'start', atMs: startMs, description: req.description, projectId: req.projectId, tags: tagIds };
		const who = await this.identity();
		if (!who.ok) return this.failOrQueue(who, op);
		const r = await this.deps.client.create(who.data.ws, createBody({ description: req.description, projectId: req.projectId, tagIds, startMs }));
		if (r.ok) {
			this.applyEntry(r.data);
			return true;
		}
		return this.failOrQueue(r, op);
	}

	async stop(): Promise<boolean> {
		const running = this.current();
		if (!running) {
			this.deps.notify('No timer is running.');
			return false;
		}
		const op: QueueOp = { kind: 'stop', atMs: this.deps.now() };
		if (isLocalId(running.id)) return this.queueOp(op);
		const who = await this.identity();
		if (!who.ok) return this.failOrQueue(who, op);
		const r = await this.deps.client.stop(who.data.ws, who.data.uid, stopBody(op.atMs));
		if (r.ok) {
			this.applyEntry(r.data);
			return true;
		}
		if (r.kind === 'http' && (r.status === 404 || r.status === 409)) void this.refresh({ force: true, background: true });
		return this.failOrQueue(r, op);
	}

	/** Stops the running timer and starts a new one. Two requests; with Pro and no connection both wait in the queue. */
	async switchTo(req: StartRequest): Promise<boolean> {
		return this.start(req);
	}

	private failOrQueue(r: Extract<Reply<unknown>, { ok: false }>, op: QueueOp): boolean {
		if (RETRYABLE.has(r.kind) && this.deps.isPro()) {
			this.offline = r.kind === 'offline';
			return this.queueOp(op);
		}
		this.fail(r, false);
		if (RETRYABLE.has(r.kind) && !this.deps.isPro()) this.deps.notify('Nothing was changed. Pro keeps a change in a queue and sends it when Clockify is reachable.');
		return false;
	}

	/** Pro: keeps the change, shows it at once, and sends it later. */
	private queueOp(op: QueueOp): boolean {
		const q = enqueue(this.state.queue, op);
		if (!q) {
			this.deps.notify('The offline queue is full (40 changes). Wait until it is sent.');
			return false;
		}
		if (this.state.queue.length === 0) {
			const run = this.current();
			this.state.queueBase = run && !isLocalId(run.id) ? { id: run.id, workspaceId: run.workspace_id, startMs: Date.parse(run.start) } : null;
		}
		this.state.queue = q;
		this.applyOptimistic(op);
		this.deps.notify('Saved. It will be sent when Clockify is reachable.');
		return true;
	}

	private applyOptimistic(op: QueueOp): void {
		const run = this.current();
		if (run) this.closeLocal(run, op.atMs);
		if (op.kind === 'start') {
			const project = this.state.projects.find((p) => p.id === op.projectId);
			const id = `${LOCAL_PREFIX}${this.state.nextTempId++}`;
			this.state.entries.push({ id, workspace_id: this.state.workspaceId ?? '', description: op.description, start: isoSeconds(op.atMs), stop: null, duration: -1, project_id: op.projectId, project_name: project?.name ?? null, project_color: project?.color ?? null, tags: op.tags });
		}
		this.changed();
	}

	// ------------------------------------------------------------ queue replay (Pro)

	/** Sends queued changes in the fewest requests. Stops at the first retryable failure and keeps the rest. */
	async flushQueue(): Promise<number> {
		if (this.flushing || !this.deps.isPro()) return 0;
		this.flushing = true;
		let sent = 0;
		try {
			for (let round = 0; round < 3; round++) {
				if (this.state.plan.length === 0 && this.state.queue.length > 0) {
					this.state.plan = planReplay(this.state.queue, this.state.queueBase);
					this.state.queue = [];
					this.state.queueBase = null;
					this.changed();
				}
				if (this.state.plan.length === 0) break;
				const done = await this.runPlan();
				sent += done;
				if (this.state.plan.length > 0) break;
			}
		} finally {
			this.flushing = false;
		}
		if (sent > 0 && this.state.plan.length === 0) {
			this.deps.notify(`Sent ${sent} queued ${sent === 1 ? 'change' : 'changes'} to Clockify.`);
			await this.refresh({ force: true, background: true });
		}
		return sent;
	}

	private async runPlan(): Promise<number> {
		let sent = 0;
		for (let i = 0; i < 40 && this.state.plan.length > 0; i++) {
			const step = this.state.plan[0];
			if (!step) break;
			const r = await this.runStep(step);
			if (!r.ok && RETRYABLE.has(r.kind)) {
				this.fail(r, true);
				break;
			}
			if (!r.ok) this.deps.notify(`A queued change was dropped: ${r.message}`);
			this.state.plan.shift();
			sent++;
			this.changed();
		}
		return sent;
	}

	private async runStep(step: PlanStep): Promise<Reply<unknown>> {
		const who = await this.identity();
		if (!who.ok) return who;
		if (step.step === 'stop') return this.deps.client.stop(who.data.ws, who.data.uid, stopBody(step.atMs));
		const r = await this.deps.client.create(who.data.ws, createBody({ description: step.description, projectId: step.projectId, tagIds: step.tags, startMs: step.startMs, stopMs: step.stopMs }));
		if (r.ok && step.stopMs === null) {
			const e = cleanEntry(r.data);
			if (e) this.state.queueBase = { id: e.id, workspaceId: e.workspace_id || who.data.ws, startMs: Date.parse(e.start) };
		}
		return r;
	}

	pending(): number {
		return this.state.queue.length + this.state.plan.length;
	}

	// ------------------------------------------------------------ edit and delete (Pro)

	async editEntry(id: string, patch: { description: string; projectId: string | null; startMs: number; stopMs: number }): Promise<boolean> {
		const e = this.state.entries.find((x) => x.id === id);
		if (!e || isLocalId(e.id)) return false;
		const ws = e.workspace_id || this.state.workspaceId || '';
		const body = createBody({ description: patch.description, projectId: patch.projectId, tagIds: e.tags ?? [], startMs: patch.startMs, stopMs: patch.stopMs, taskId: e.task_id, billable: e.billable });
		const r = await this.deps.client.update(ws, id, body);
		if (!r.ok) {
			this.fail(r, false);
			return false;
		}
		this.applyEntry(r.data);
		return true;
	}

	async deleteEntry(id: string): Promise<boolean> {
		const e = this.state.entries.find((x) => x.id === id);
		if (!e || isLocalId(e.id)) return false;
		const r = await this.deps.client.remove(e.workspace_id || this.state.workspaceId || '', id);
		if (!r.ok) {
			this.fail(r, false);
			return false;
		}
		this.state.entries = this.state.entries.filter((x) => x.id !== id);
		this.changed();
		return true;
	}

	// ------------------------------------------------------------ report (Pro)

	private async reportEntries(fromMs: number, toMs: number): Promise<Reply<unknown[]>> {
		const who = await this.identity();
		if (!who.ok) return who;
		return this.deps.client.entriesAll(who.data.ws, who.data.uid, fromMs, toMs);
	}

	/** Hours by project, day or description. "today" and "yesterday" come from the cache when they can; other ranges cost one request each 15 minutes. */
	async report(spec: { range: string; by: GroupBy }, force = false): Promise<Report | { error: string }> {
		const now = this.deps.now();
		const tz = this.deps.tzOffsetMin();
		const range = rangeFor(spec.range, now, tz, this.deps.weekStart());
		if (!range) return { error: 'Range must be today, yesterday, last7, week, month or YYYY-MM-DD..YYYY-MM-DD.' };
		const key = `${range.fromMs}:${range.toMs}`;
		const hit = this.reports.get(key);
		let entries: TimeEntry[] | null = hit && !force && now - hit.at < REPORT_TTL_MS ? hit.entries : null;
		let stale = false;
		let at = hit?.at ?? now;
		if (!entries) {
			let pending = this.inflight.get(key);
			if (!pending) {
				pending = this.reportEntries(range.fromMs, range.toMs).finally(() => this.inflight.delete(key));
				this.inflight.set(key, pending);
			}
			const r = await pending;
			if (r.ok) {
				entries = cleanList(r.data, cleanEntry, 1000);
				at = now;
				this.reports.set(key, { entries, at });
				this.offline = false;
			} else if (hit) {
				entries = hit.entries;
				stale = true;
			} else {
				this.fail(r, true);
				return { error: r.message };
			}
		}
		const rows = groupSeconds(entries, spec.by, now, range, tz);
		return { label: range.label, by: spec.by, rows, totalSeconds: rows.reduce((a, r) => a + r.seconds, 0), updatedAt: at, stale };
	}
}

export { APP_NAME };
