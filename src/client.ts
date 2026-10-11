// Clockify API v1 client over Obsidian requestUrl (no Node, works on phone and tablet).
// Every request goes through the request budget in logic.ts: our own cap of 120 requests an hour, 429 and 5xx back off.
// The API key is read from SecretStorage for each request. It is never stored here, logged or put in an error text.
import { requestUrl } from 'obsidian';
import { afterAnswer, authHeaders, canSend, formatWait, newBudget, type Budget, type Project, type Tag } from './logic';

export interface HttpRequest {
	/** Path after /api/v1, starting with "/". */
	path: string;
	method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
	headers: Record<string, string>;
	body?: string;
}
export interface HttpReply {
	status: number;
	json: unknown;
	headers: Record<string, string>;
}
export type Http = (r: HttpRequest) => Promise<HttpReply>;

/**
 * The one network call site of the Clockify client. The URL starts with a literal prefix that ends the host, so the path
 * cannot change the host (tools/network-gate.mjs, product.yaml network_path_hosts). status 0 means no answer: offline.
 */
export const obsidianHttp: Http = async (r) => {
	try {
		const res = await requestUrl({ url: `https://api.clockify.me/api/v1${r.path}`, method: r.method, headers: r.headers, body: r.body, throw: false });
		let json: unknown = null;
		try {
			json = res.json;
		} catch {
			json = null;
		}
		return { status: res.status, json, headers: res.headers };
	} catch {
		return { status: 0, json: null, headers: {} };
	}
};

export type FailKind = 'no-token' | 'blocked' | 'quota' | 'offline' | 'rate' | 'server' | 'auth' | 'http';
export type Reply<T> = { ok: true; status: number; data: T; lastPage: boolean } | { ok: false; kind: FailKind; status: number; waitMs: number; message: string };

/** Failures that a queued change may retry later. Auth and other 4xx answers are not queued. */
export const RETRYABLE: ReadonlySet<FailKind> = new Set<FailKind>(['blocked', 'quota', 'offline', 'rate', 'server']);

const header = (h: Record<string, string>, name: string): string | null => {
	const key = Object.keys(h).find((k) => k.toLowerCase() === name);
	return key === undefined ? null : (h[key] ?? null);
};
const num = (v: string | null): number | null => {
	if (v === null || v.trim() === '') return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
};

/** The user from GET /user: the id the stop path needs and the default workspace. */
export interface Me {
	id: string;
	name: string;
	defaultWorkspace: string;
}

export interface ClockifyOptions {
	getToken: () => string | null;
	http: Http;
	now: () => number;
	/** Called after each request, so the plugin can save the budget. */
	onBudget: () => void;
}

/** Page size of list calls. One page holds a busy day. A report follows the Last-Page header for at most MAX_PAGES pages. */
export const PAGE_SIZE = 500;
export const MAX_PAGES = 4;

export class ClockifyClient {
	budget: Budget = newBudget();
	opts: ClockifyOptions;

	constructor(opts: ClockifyOptions) {
		this.opts = opts;
	}

	async call<T>(method: HttpRequest['method'], path: string, body: unknown, background: boolean): Promise<Reply<T>> {
		const token = this.opts.getToken();
		if (!token) return fail('no-token', 0, 0, 'Add your Clockify API key in the plugin settings.');
		const now = this.opts.now();
		const verdict = canSend(this.budget, now, background);
		if (!verdict.ok) {
			const kind: FailKind = verdict.reason === 'blocked' ? 'blocked' : 'quota';
			return fail(kind, 0, verdict.waitMs, `The plugin keeps its own request limit. Try again in ${formatWait(verdict.waitMs)}.`);
		}
		const reply = await this.opts.http({ path, method, headers: authHeaders(token), body: body === undefined ? undefined : JSON.stringify(body) });
		const after = this.opts.now();
		this.budget = afterAnswer(this.budget, { status: reply.status, retryAfterSecs: num(header(reply.headers, 'retry-after')) }, after, Math.random());
		this.opts.onBudget();
		return classify<T>(reply, Math.max(0, this.budget.blockedUntilMs - after));
	}

	me(background = false): Promise<Reply<Me>> {
		return this.call<Me>('GET', '/user', undefined, background);
	}

	private listPath(ws: string, uid: string, query: string): string {
		return `/workspaces/${ws}/user/${uid}/time-entries?hydrated=true&page-size=${PAGE_SIZE}&${query}`;
	}

	/** Entries that start in [fromMs, toMs), with project names. One request gives the running timer and the day total. */
	entries(ws: string, uid: string, fromMs: number, toMs: number, background: boolean): Promise<Reply<unknown[]>> {
		if (!validId(ws) || !validId(uid)) return Promise.resolve(BAD_ID);
		const a = encodeURIComponent(new Date(fromMs).toISOString().replace('.000Z', 'Z'));
		const b = encodeURIComponent(new Date(toMs).toISOString().replace('.000Z', 'Z'));
		return this.call<unknown[]>('GET', this.listPath(ws, uid, `start=${a}&end=${b}`), undefined, background);
	}

	/** Like entries, but follows the Last-Page header for a long range: one request per page, at most MAX_PAGES. */
	async entriesAll(ws: string, uid: string, fromMs: number, toMs: number): Promise<Reply<unknown[]>> {
		if (!validId(ws) || !validId(uid)) return BAD_ID;
		const a = encodeURIComponent(new Date(fromMs).toISOString().replace('.000Z', 'Z'));
		const b = encodeURIComponent(new Date(toMs).toISOString().replace('.000Z', 'Z'));
		const all: unknown[] = [];
		for (let page = 1; page <= MAX_PAGES; page++) {
			const r = await this.call<unknown[]>('GET', this.listPath(ws, uid, `start=${a}&end=${b}&page=${page}`), undefined, false);
			if (!r.ok) return r;
			if (Array.isArray(r.data)) all.push(...r.data);
			if (r.lastPage) return { ok: true, status: r.status, data: all, lastPage: true };
		}
		return { ok: true, status: 200, data: all, lastPage: false };
	}

	/** The timer that runs now, or null. Used by a manual refresh: a timer that started before yesterday is not in the date range. */
	async current(ws: string, uid: string): Promise<Reply<unknown>> {
		if (!validId(ws) || !validId(uid)) return BAD_ID;
		const r = await this.call<unknown[]>('GET', `/workspaces/${ws}/user/${uid}/time-entries?hydrated=true&in-progress=true&page-size=1`, undefined, false);
		if (!r.ok) return r;
		return { ok: true, status: r.status, data: Array.isArray(r.data) ? (r.data[0] ?? null) : null, lastPage: true };
	}

	projects(ws: string, background = false): Promise<Reply<Project[]>> {
		if (!validId(ws)) return Promise.resolve(BAD_ID);
		return this.call<Project[]>('GET', `/workspaces/${ws}/projects?archived=false&page-size=${PAGE_SIZE}`, undefined, background);
	}

	tags(ws: string, background = false): Promise<Reply<Tag[]>> {
		if (!validId(ws)) return Promise.resolve(BAD_ID);
		return this.call<Tag[]>('GET', `/workspaces/${ws}/tags?archived=false&page-size=${PAGE_SIZE}`, undefined, background);
	}

	create(ws: string, body: Record<string, unknown>): Promise<Reply<unknown>> {
		if (!validId(ws)) return Promise.resolve(BAD_ID);
		return this.call<unknown>('POST', `/workspaces/${ws}/time-entries`, body, false);
	}

	/** Stops the running timer of the user: PATCH /workspaces/{ws}/user/{uid}/time-entries with the end time. */
	stop(ws: string, uid: string, body: Record<string, unknown>): Promise<Reply<unknown>> {
		if (!validId(ws) || !validId(uid)) return Promise.resolve(BAD_ID);
		return this.call<unknown>('PATCH', `/workspaces/${ws}/user/${uid}/time-entries`, body, false);
	}

	update(ws: string, entryId: string, body: Record<string, unknown>): Promise<Reply<unknown>> {
		if (!validId(ws) || !validId(entryId)) return Promise.resolve(BAD_ID);
		return this.call<unknown>('PUT', `/workspaces/${ws}/time-entries/${entryId}`, body, false);
	}

	remove(ws: string, entryId: string): Promise<Reply<unknown>> {
		if (!validId(ws) || !validId(entryId)) return Promise.resolve(BAD_ID);
		return this.call<unknown>('DELETE', `/workspaces/${ws}/time-entries/${entryId}`, undefined, false);
	}
}

/** Ids go into the URL path, so only 24 hex digits pass (the Clockify id shape). No request is sent for any other value. */
export function validId(id: string): boolean {
	return /^[0-9a-f]{24}$/i.test(id);
}

const BAD_ID = { ok: false, kind: 'http', status: 0, waitMs: 0, message: 'The entry has no Clockify id yet. Run "Refresh timer" and try again.' } as const;

function fail(kind: FailKind, status: number, waitMs: number, message: string): { ok: false; kind: FailKind; status: number; waitMs: number; message: string } {
	return { ok: false, kind, status, waitMs, message };
}

/** Maps a reply to a result. The message never holds the key or a header. */
function classify<T>(r: HttpReply, waitMs: number): Reply<T> {
	if (r.status >= 200 && r.status < 300) return { ok: true, status: r.status, data: r.json as T, lastPage: header(r.headers, 'last-page') !== 'false' };
	if (r.status === 0) return fail('offline', 0, waitMs, 'No connection to Clockify.');
	if (r.status === 429) return fail('rate', 429, waitMs, `Clockify says too many requests. Try again in ${formatWait(waitMs)}.`);
	if (r.status === 401 || r.status === 403) return fail('auth', r.status, 0, 'Clockify did not accept the API key. Check it in the plugin settings.');
	if (r.status >= 500) return fail('server', r.status, waitMs, 'Clockify has a problem. Try again soon.');
	const text = isRecord(r.json) && typeof r.json.message === 'string' ? r.json.message.slice(0, 120) : '';
	return fail('http', r.status, 0, `Clockify answered ${r.status}${text ? `: ${text}` : ''}.`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}
