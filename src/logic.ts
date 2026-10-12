// Pure logic of Mobile Timer for Clockify: time math, request budget, offline queue, report ranges.
// No Obsidian import and no network here, so every function runs in vitest with golden vectors.
// Clockify API facts come from the page saved in research/obsidian-run/raw/b4 (see BRIEF.md).

/** One time entry in the plugin's own shape. fromWire turns a Clockify entry into this. Ids are text (24 hex digits at Clockify). */
export interface TimeEntry {
	id: string;
	workspace_id: string;
	description: string | null;
	start: string;
	stop: string | null;
	/** Seconds, or -1 while the timer runs. */
	duration: number;
	project_id: string | null;
	project_name?: string | null;
	project_color?: string | null;
	/** Tag ids. */
	tags?: string[] | null;
	task_id?: string | null;
	billable?: boolean;
}

export interface Project {
	id: string;
	workspace_id: string;
	name: string;
	color: string;
	active: boolean;
}

export interface Tag {
	id: string;
	name: string;
}

/** Entries that wait in the offline queue have an id with this prefix until Clockify gives them a real one. */
export const LOCAL_PREFIX = 'local-';
export const isLocalId = (id: string): boolean => id.startsWith(LOCAL_PREFIX);

export const APP_NAME = 'Mobile Timer for Clockify';
const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------- formatting

/** Request headers. Clockify takes a personal API key in the X-Api-Key header (docs: Authentication). */
export function authHeaders(key: string): Record<string, string> {
	return { 'X-Api-Key': key, 'Content-Type': 'application/json' };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/**
 * One Clockify time entry (GET .../time-entries with hydrated=true) in the plugin shape. A running entry has
 * timeInterval.end null. Null for anything without an id and a start time.
 */
export function fromWire(v: unknown): TimeEntry | null {
	if (!isObj(v) || !isObj(v.timeInterval)) return null;
	const id = str(v.id);
	const start = str(v.timeInterval.start);
	if (id === null || start === null || !Number.isFinite(Date.parse(start))) return null;
	const end = str(v.timeInterval.end);
	const endMs = end === null ? NaN : Date.parse(end);
	const stop = Number.isFinite(endMs) ? end : null;
	const project = isObj(v.project) ? v.project : null;
	return {
		id,
		workspace_id: str(v.workspaceId) ?? '',
		description: typeof v.description === 'string' ? v.description : null,
		start,
		stop,
		duration: stop === null ? -1 : Math.max(0, Math.round((endMs - Date.parse(start)) / 1000)),
		project_id: str(v.projectId),
		project_name: project ? str(project.name) : null,
		project_color: project ? str(project.color) : null,
		tags: Array.isArray(v.tagIds) ? v.tagIds.filter((t): t is string => typeof t === 'string') : null,
		task_id: str(v.taskId),
		billable: v.billable === true,
	};
}

/** Tag ids for tag names (any case). A name with no tag is left out, so a typo never creates a tag. */
export function tagIdsFor(names: readonly string[], tags: readonly Tag[]): string[] {
	const out: string[] = [];
	for (const n of names) {
		const hit = tags.find((t) => t.name.toLowerCase() === n.trim().toLowerCase());
		if (hit && !out.includes(hit.id)) out.push(hit.id);
	}
	return out;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 3725 gives "1:02:05". Negative and not-finite input gives "0:00:00". */
export function formatClock(seconds: number): string {
	const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
	return `${Math.floor(s / 3600)}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
}

/** 7500 gives "2h 05m", 2700 gives "45m", 0 gives "0m". Seconds are cut, not rounded. */
export function formatHours(seconds: number): string {
	const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	return h > 0 ? `${h}h ${pad2(m)}m` : `${m}m`;
}

/** Decimal hours with 2 places, for reports: 5400 gives "1.50". */
export function decimalHours(seconds: number): string {
	return (Math.max(0, seconds) / 3600).toFixed(2);
}

// ---------------------------------------------------------------- time math

/** True when the entry has no stop time and a negative duration (fromWire gives -1 to an entry with no end). */
export function isRunning(e: Pick<TimeEntry, 'stop' | 'duration'>): boolean {
	return e.stop === null && e.duration < 0;
}

/** Seconds of one entry. A running entry counts from its server start time, so the value is right after a phone sleeps. */
export function entrySeconds(e: TimeEntry, nowMs: number): number {
	const start = Date.parse(e.start);
	if (!Number.isFinite(start)) return 0;
	if (e.stop) {
		const stop = Date.parse(e.stop);
		return Number.isFinite(stop) ? Math.max(0, (stop - start) / 1000) : 0;
	}
	return isRunning(e) ? Math.max(0, (nowMs - start) / 1000) : Math.max(0, e.duration);
}

/** Seconds of one entry that fall in [fromMs, toMs). A timer across midnight counts in both days. */
export function clippedSeconds(e: TimeEntry, nowMs: number, fromMs: number, toMs: number): number {
	const start = Date.parse(e.start);
	if (!Number.isFinite(start)) return 0;
	const end = start + entrySeconds(e, nowMs) * 1000;
	return Math.max(0, Math.min(end, toMs) - Math.max(start, fromMs)) / 1000;
}

export function totalSeconds(entries: readonly TimeEntry[], nowMs: number, fromMs: number, toMs: number): number {
	let sum = 0;
	for (const e of entries) sum += clippedSeconds(e, nowMs, fromMs, toMs);
	return Math.round(sum);
}

/** Start and end (ms, end excluded) of the local day that holds nowMs. tzOffsetMin is minutes east of UTC. */
export function dayBounds(nowMs: number, tzOffsetMin: number): { fromMs: number; toMs: number } {
	const shifted = nowMs + tzOffsetMin * MIN_MS;
	const startShifted = Math.floor(shifted / DAY_MS) * DAY_MS;
	const fromMs = startShifted - tzOffsetMin * MIN_MS;
	return { fromMs, toMs: fromMs + DAY_MS };
}

export type RangeKind = 'today' | 'yesterday' | 'week' | 'month' | 'last7' | 'custom';
export interface DateRange {
	kind: RangeKind;
	fromMs: number;
	toMs: number;
	label: string;
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Local midnight (ms) of YYYY-MM-DD, or null for a bad date. */
export function parseDay(text: string, tzOffsetMin: number): number | null {
	const m = ISO_DAY.exec(text.trim());
	if (!m) return null;
	const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
	const utc = Date.UTC(y, mo - 1, d);
	const back = new Date(utc);
	if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
	return utc - tzOffsetMin * MIN_MS;
}

export function dayText(ms: number, tzOffsetMin: number): string {
	const d = new Date(ms + tzOffsetMin * MIN_MS);
	return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Range from a word (today, yesterday, week, month, last7) or "YYYY-MM-DD..YYYY-MM-DD" (last day included). weekStart 1 = Monday. */
export function rangeFor(spec: string, nowMs: number, tzOffsetMin: number, weekStart = 1): DateRange | null {
	const word = spec.trim().toLowerCase();
	const today = dayBounds(nowMs, tzOffsetMin);
	if (word === 'today') return { kind: 'today', ...today, label: dayText(today.fromMs, tzOffsetMin) };
	if (word === 'yesterday') return { kind: 'yesterday', fromMs: today.fromMs - DAY_MS, toMs: today.fromMs, label: dayText(today.fromMs - DAY_MS, tzOffsetMin) };
	if (word === 'last7') return { kind: 'last7', fromMs: today.toMs - 7 * DAY_MS, toMs: today.toMs, label: 'last 7 days' };
	if (word === 'week') {
		const dow = new Date(today.fromMs + tzOffsetMin * MIN_MS).getUTCDay();
		const back = (dow - weekStart + 7) % 7;
		const fromMs = today.fromMs - back * DAY_MS;
		return { kind: 'week', fromMs, toMs: fromMs + 7 * DAY_MS, label: `week of ${dayText(fromMs, tzOffsetMin)}` };
	}
	if (word === 'month') {
		const d = new Date(today.fromMs + tzOffsetMin * MIN_MS);
		const fromMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - tzOffsetMin * MIN_MS;
		const toMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - tzOffsetMin * MIN_MS;
		return { kind: 'month', fromMs, toMs, label: dayText(fromMs, tzOffsetMin).slice(0, 7) };
	}
	return customRange(word, tzOffsetMin);
}

function customRange(spec: string, tzOffsetMin: number): DateRange | null {
	const parts = spec.split('..');
	if (parts.length !== 2) return null;
	const a = parseDay(parts[0] ?? '', tzOffsetMin);
	const b = parseDay(parts[1] ?? '', tzOffsetMin);
	if (a === null || b === null || b < a || b - a > 366 * DAY_MS) return null;
	return { kind: 'custom', fromMs: a, toMs: b + DAY_MS, label: `${dayText(a, tzOffsetMin)} to ${dayText(b, tzOffsetMin)}` };
}

export type GroupBy = 'project' | 'day' | 'description';
export interface GroupRow {
	key: string;
	seconds: number;
	color: string | null;
}

/** Seconds per project, day or description inside the range. Biggest first; ties by key. Days sort by date. */
export function groupSeconds(entries: readonly TimeEntry[], by: GroupBy, nowMs: number, range: Pick<DateRange, 'fromMs' | 'toMs'>, tzOffsetMin: number): GroupRow[] {
	const map = new Map<string, GroupRow>();
	for (const e of entries) {
		const sec = clippedSeconds(e, nowMs, range.fromMs, range.toMs);
		if (sec <= 0) continue;
		const key = groupKey(e, by, tzOffsetMin);
		const row = map.get(key) ?? { key, seconds: 0, color: by === 'project' ? (e.project_color ?? null) : null };
		row.seconds += sec;
		map.set(key, row);
	}
	const rows = [...map.values()].map((r) => ({ ...r, seconds: Math.round(r.seconds) }));
	rows.sort(by === 'day' ? (a, b) => a.key.localeCompare(b.key) : (a, b) => b.seconds - a.seconds || a.key.localeCompare(b.key));
	return rows;
}

function groupKey(e: TimeEntry, by: GroupBy, tzOffsetMin: number): string {
	if (by === 'project') return e.project_name || 'No project';
	if (by === 'day') return dayText(Date.parse(e.start), tzOffsetMin);
	return (e.description ?? '').trim() || '(no description)';
}

// ---------------------------------------------------------------- request budget

export interface Budget {
	/** No request before this time (ms). 0 = free. */
	blockedUntilMs: number;
	/** Failures in a row (429, 5xx, no network). 0 after a good answer. */
	failures: number;
	/** Times (ms) of requests sent in the last 60 minutes. */
	sent: number[];
}

/**
 * Our own cap, not a Clockify limit. The Clockify docs state 50 requests a second for an add-on key and name no limit for a
 * personal key, so the plugin keeps itself far below that: 120 requests in a rolling hour.
 */
export const HOURLY_CAP = 120;
/** Background refreshes stop when this many requests or fewer are left, so a tap on Start or Stop still works. */
export const RESERVE = 8;

export function newBudget(): Budget {
	return { blockedUntilMs: 0, failures: 0, sent: [] };
}

export interface Answer {
	status: number;
	/** Seconds from the Retry-After header of a 429 answer, when Clockify sends it. */
	retryAfterSecs?: number | null;
}

/** Wait time after a failed answer. 429 follows Retry-After, else backs off for minutes; 5xx and no network back off short. */
export function backoffMs(status: number, failures: number, retryAfterSecs: number | null | undefined, jitter01 = 0): number {
	const n = Math.min(Math.max(failures, 0), 6);
	if (status === 429) {
		if (retryAfterSecs && retryAfterSecs > 0) return Math.min(HOUR_MS, retryAfterSecs * 1000 + 1000);
		return Math.min(20 * MIN_MS, MIN_MS * 2 ** n);
	}
	if (status >= 500 || status === 0) return Math.min(5 * MIN_MS, 10_000 * 2 ** n) + Math.floor(jitter01 * 10_000);
	return 0;
}

/** New budget after one request. status 0 means the request never reached Clockify (offline). */
export function afterAnswer(b: Budget, a: Answer, nowMs: number, jitter01 = 0): Budget {
	const sent = [...b.sent.filter((t) => nowMs - t < HOUR_MS), nowMs].slice(-200);
	const out: Budget = { ...b, sent };
	const ok = a.status >= 200 && a.status < 300;
	// 4xx answers other than 429 are our own mistake or a missing item: they do not block later requests.
	const blocking = a.status === 429 || a.status >= 500 || a.status === 0;
	if (ok || !blocking) {
		return { ...out, failures: ok ? 0 : b.failures };
	}
	const wait = backoffMs(a.status, b.failures, a.retryAfterSecs, jitter01);
	return { ...out, failures: b.failures + 1, blockedUntilMs: Math.max(b.blockedUntilMs, nowMs + wait) };
}

/** Requests left in our own hourly cap: the cap minus what we sent in the last hour. */
export function remainingNow(b: Budget, nowMs: number, limit = HOURLY_CAP): number {
	return limit - b.sent.filter((t) => nowMs - t < HOUR_MS).length;
}

export interface Verdict {
	ok: boolean;
	waitMs: number;
	reason: 'ok' | 'blocked' | 'quota' | 'reserve';
}

/** May a request go now? User actions (Start, Stop) may use the last requests; background refreshes keep RESERVE in hand. */
export function canSend(b: Budget, nowMs: number, background: boolean, limit = HOURLY_CAP): Verdict {
	if (nowMs < b.blockedUntilMs) return { ok: false, waitMs: b.blockedUntilMs - nowMs, reason: 'blocked' };
	const left = remainingNow(b, nowMs, limit);
	const need = background ? RESERVE + 1 : 1;
	if (left >= need) return { ok: true, waitMs: 0, reason: 'ok' };
	const windowEnd = (b.sent.find((t) => nowMs - t < HOUR_MS) ?? nowMs) + HOUR_MS;
	return { ok: false, waitMs: Math.max(0, windowEnd - nowMs), reason: background && left > 0 ? 'reserve' : 'quota' };
}

/** "in 4 min", "in 35 s", "in 1 h 5 min": a wait for a Notice. */
export function formatWait(ms: number): string {
	const s = Math.max(1, Math.ceil(ms / 1000));
	if (s < 60) return `${s} s`;
	const m = Math.ceil(s / 60);
	return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

// ---------------------------------------------------------------- freshness

/** Background refresh is due when the cache is older than ttlMs or from another day. */
export function isStale(fetchedAtMs: number | null, nowMs: number, ttlMs: number, tzOffsetMin: number): boolean {
	if (fetchedAtMs === null) return true;
	if (nowMs - fetchedAtMs >= ttlMs || nowMs < fetchedAtMs) return true;
	return dayBounds(fetchedAtMs, tzOffsetMin).fromMs !== dayBounds(nowMs, tzOffsetMin).fromMs;
}

// ---------------------------------------------------------------- offline queue

export interface StartOp {
	kind: 'start';
	atMs: number;
	description: string;
	projectId: string | null;
	tags: string[];
}
export interface StopOp {
	kind: 'stop';
	atMs: number;
}
export type QueueOp = StartOp | StopOp;

export const QUEUE_MAX = 40;

export interface CreateStep {
	step: 'create';
	startMs: number;
	/** null = the timer is still running. */
	stopMs: number | null;
	description: string;
	projectId: string | null;
	tags: string[];
}
export interface StopStep {
	step: 'stop';
	entryId: string;
	workspaceId: string;
	/** Start of the entry that runs on Clockify, so the update can send a consistent start, stop and duration. */
	startMs: number;
	atMs: number;
}
export interface ServerTimer {
	id: string;
	workspaceId: string;
	startMs: number;
}
export type PlanStep = CreateStep | StopStep;

/** Adds an op. Returns null when the queue is full, so the caller can tell the user. */
export function enqueue(queue: readonly QueueOp[], op: QueueOp, max = QUEUE_MAX): QueueOp[] | null {
	if (queue.length >= max) return null;
	return [...queue, op];
}

function finish(o: StartOp, stopMs: number): CreateStep | null {
	if (stopMs <= o.atMs) return null;
	return { step: 'create', startMs: o.atMs, stopMs, description: o.description, projectId: o.projectId, tags: o.tags };
}

/**
 * Turns queued ops into the fewest requests. A start followed by a stop becomes one finished entry (1 request, not 2).
 * A start while another runs ends the first one at that moment, as Clockify does. server is the timer that ran on Clockify
 * when the queue began, or null.
 */
export function planReplay(ops: readonly QueueOp[], server: ServerTimer | null): PlanStep[] {
	const steps: PlanStep[] = [];
	let open: StartOp | null = null;
	let srv = server;
	const sorted = [...ops].sort((a, b) => a.atMs - b.atMs);
	for (const op of sorted) {
		if (open) {
			const done = finish(open, op.atMs);
			if (done) steps.push(done);
			open = null;
		} else if (srv) {
			steps.push({ step: 'stop', entryId: srv.id, workspaceId: srv.workspaceId, startMs: srv.startMs, atMs: op.atMs });
			srv = null;
		}
		if (op.kind === 'start') open = op;
	}
	if (open) steps.push({ step: 'create', startMs: open.atMs, stopMs: null, description: open.description, projectId: open.projectId, tags: open.tags });
	return steps;
}

// ---------------------------------------------------------------- request bodies

/** UTC time without milliseconds, as the Clockify docs show: yyyy-MM-ddThh:mm:ssZ. */
export function isoSeconds(ms: number): string {
	return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

export interface StartInput {
	description: string;
	projectId: string | null;
	/** Tag ids. */
	tagIds: string[];
	startMs: number;
	stopMs?: number | null;
	taskId?: string | null;
	billable?: boolean;
}

/** Clockify keeps a description to 3000 characters. */
export const DESCRIPTION_MAX = 3000;

/**
 * Body for POST /workspaces/{id}/time-entries and PUT .../time-entries/{id}. A running timer has a start and no end.
 * PUT replaces the entry, so an edit sends the project, tags, task and billable flag again. A cleared project is left out.
 */
export function createBody(i: StartInput): Record<string, unknown> {
	const body: Record<string, unknown> = { start: isoSeconds(i.startMs), description: i.description.slice(0, DESCRIPTION_MAX) };
	if (i.stopMs !== undefined && i.stopMs !== null) body.end = isoSeconds(i.stopMs);
	if (i.projectId !== null) body.projectId = i.projectId;
	if (i.tagIds.length > 0) body.tagIds = i.tagIds;
	if (i.taskId) body.taskId = i.taskId;
	if (i.billable === true) body.billable = true;
	return body;
}

/** Body for PATCH /workspaces/{id}/user/{userId}/time-entries, which stops the running timer of that user. */
export function stopBody(endMs: number): Record<string, unknown> {
	return { end: isoSeconds(endMs) };
}

// ---------------------------------------------------------------- projects and notes

/** Project by exact name (any case) or project id text. */
export function findProject(projects: readonly Project[], ref: string): Project | null {
	const text = ref.trim().toLowerCase();
	if (!text) return null;
	return projects.find((p) => p.active && (p.name.toLowerCase() === text || p.id.toLowerCase() === text)) ?? null;
}

/** Project reference from note properties: "clockify-project" or "clockify_project". Not a string gives null. */
export function noteProjectRef(frontmatter: Record<string, unknown> | null | undefined): string | null {
	const raw = frontmatter?.['clockify-project'] ?? frontmatter?.['clockify_project'];
	return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

/** Splits "a, b ,,c" into clean tag names, at most 10. */
export function parseTags(text: string): string[] {
	const out: string[] = [];
	for (const t of text.split(',')) {
		const v = t.trim();
		if (v && !out.includes(v) && out.length < 10) out.push(v);
	}
	return out;
}

/** Description for a timer started from a note: the note name, cut at 120 characters. */
export function descriptionFromNote(basename: string): string {
	return basename.trim().slice(0, 120);
}

/**
 * The description that a note offers to Clockify. With the setting "Use the note title as the description" off, or with no
 * open note, it is empty, so no note title goes into a request unless the user types it.
 */
export function noteDescription(basename: string | null | undefined, useTitle: boolean): string {
	return useTitle && typeof basename === 'string' ? descriptionFromNote(basename) : '';
}

/** Marks that start the Tasks plugin metadata at the end of a task line: dates, priority, recurrence, id, dependency. */
const TASK_META = /\s*[\u{1F4C5}\u{23F3}\u{1F6EB}\u{2795}\u{2705}\u{274C}\u{1F501}\u{1F3C1}\u{23EB}\u{1F53C}\u{1F53D}\u{23EC}\u{1F53A}\u{1F194}\u{26D4}].*$/u;

/**
 * The description that one line of a note offers to Clockify, for "Start timer for this task". It drops the quote, list and
 * checkbox marks, the heading marks, a block id, the Tasks plugin metadata, link brackets (an alias or the last part of a
 * path stays) and bold, strike, highlight and code marks. The text is cut at 120 characters (code points). A line with no text gives "".
 */
export function taskDescription(line: string): string {
	let t = line.replace(TASK_META, '').replace(/\s\^[A-Za-z0-9-]+\s*$/, '');
	t = t.replace(/^[\s>]*/, '').replace(/^(?:[-*+]|\d+[.)])(?:\s+|$)/, '').replace(/^\[[^\]]\](?:\s+|$)/, '').replace(/^#{1,6}(?:\s+|$)/, '');
	t = t.replace(/!\[\[[^\]]*\]\]/g, '').replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1');
	t = t.replace(/\[\[([^\]]*)\]\]/g, (_m, target: string) => target.split('/').pop() ?? '');
	t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*\*|__|~~|==|`/g, '');
	// Cut by code point, so the cut never leaves half an emoji (a lone surrogate) in the request.
	return Array.from(t.replace(/\s+/g, ' ').trim()).slice(0, 120).join('').trim();
}

// ---------------------------------------------------------------- report block

export interface ReportSpec {
	range: string;
	by: GroupBy;
	title: string;
}

/** Reads the lines of a clockify-report code block: "range: week", "by: project", "title: text". Returns an error text for a bad line. */
export function parseReportSpec(source: string): { spec: ReportSpec } | { error: string } {
	const spec: ReportSpec = { range: 'today', by: 'project', title: '' };
	for (const raw of source.split('\n').slice(0, 20)) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const i = line.indexOf(':');
		if (i < 1) return { error: `Cannot read the line "${line.slice(0, 40)}". Use "range: week".` };
		const key = line.slice(0, i).trim().toLowerCase();
		const val = line.slice(i + 1).trim();
		if (key === 'range') spec.range = val;
		else if (key === 'by') {
			if (val !== 'project' && val !== 'day' && val !== 'description') return { error: 'by must be project, day or description.' };
			spec.by = val;
		} else if (key === 'title') spec.title = val.slice(0, 80);
		else return { error: `Unknown key "${key.slice(0, 20)}". Use range, by or title.` };
	}
	return { spec };
}

/** A report as a Markdown table text with a total row. Used for the copy button and in tests. */
export function reportMarkdown(rows: readonly GroupRow[], by: GroupBy): string {
	const head = by === 'project' ? 'Project' : by === 'day' ? 'Day' : 'Description';
	const lines = [`| ${head} | Hours |`, '| --- | ---: |'];
	let total = 0;
	for (const r of rows) {
		total += r.seconds;
		lines.push(`| ${r.key.replace(/\|/g, '\\|')} | ${decimalHours(r.seconds)} |`);
	}
	lines.push(`| **Total** | **${decimalHours(total)}** |`);
	return lines.join('\n');
}

// ---------------------------------------------------------------- golden vectors

/** One entry point for packages/spec/vectors/clockify-mobile-timer.json: fn names a function above, args are its arguments. */
export function evalVector(fn: string, args: unknown[]): unknown {
	const table: Record<string, (...a: never[]) => unknown> = {
		formatClock,
		formatHours,
		decimalHours,
		entrySeconds,
		clippedSeconds,
		totalSeconds,
		dayBounds,
		rangeFor,
		groupSeconds,
		backoffMs,
		afterAnswer,
		canSend,
		remainingNow,
		formatWait,
		isStale,
		planReplay,
		createBody,
		isoSeconds,
		findProject,
		noteProjectRef,
		taskDescription,
		parseTags,
		parseReportSpec,
		reportMarkdown,
		authHeaders,
		fromWire,
		tagIdsFor,
		stopBody,
		enqueue,
	};
	const f = table[fn];
	if (!f) throw new Error(`unknown vector function ${fn}`);
	return (f as (...a: unknown[]) => unknown)(...args);
}
