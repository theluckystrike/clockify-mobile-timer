import type { Http, HttpReply, HttpRequest } from '../src/client';

export const WS = 'a1b2c3d4e5f6a1b2c3d4e5f6';
export const UID = '0a0b0c0d0e0f0a0b0c0d0e0f';
export const PROJ_DOCS = '5b641568b07987035750505e';
export const PROJ_CODE = '5b641568b07987035750505f';
export const TAG_X = '7e4117fe8c625f38930d57b7';

/** One entry in the Clockify wire shape. end null = the timer runs. */
export function wireEntry(id: string, start: string, end: string | null, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { id, description: '', userId: UID, workspaceId: WS, projectId: null, tagIds: [], billable: false, timeInterval: { start, end, duration: null }, ...extra };
}

/** A fake Clockify: keeps entries in memory, counts requests, and can be told to fail. */
export class FakeClockify {
	calls: HttpRequest[] = [];
	entries: Record<string, unknown>[] = [];
	/** Answer of the in-progress list: a timer from before the date range, or null. */
	current: Record<string, unknown> | null = null;
	nextId = 0;
	mode: 'ok' | 'offline' | '429' | '401' = 'ok';
	retryAfter: string | null = null;
	stopAt = '2026-10-10T08:10:00Z';

	private newId(): string {
		this.nextId += 1;
		return this.nextId.toString(16).padStart(24, 'c');
	}

	http: Http = (r) => {
		this.calls.push(r);
		if (this.mode === 'offline') return Promise.resolve({ status: 0, json: null, headers: {} });
		if (this.mode === '401') return Promise.resolve({ status: 401, json: { message: 'Full authentication is required', code: 4003 }, headers: {} });
		if (this.mode === '429') return Promise.resolve({ status: 429, json: { message: 'Too many requests' }, headers: this.retryAfter ? { 'Retry-After': this.retryAfter } : {} });
		return Promise.resolve(this.answer(r));
	};

	private answer(r: HttpRequest): HttpReply {
		const headers = { 'Last-Page': 'true' };
		const body = r.body ? (JSON.parse(r.body) as Record<string, unknown>) : {};
		if (r.method === 'GET' && r.path === '/user') return { status: 200, json: { id: UID, name: 'Demo User', defaultWorkspace: WS, activeWorkspace: WS }, headers };
		if (r.method === 'GET' && r.path.includes('in-progress=true')) return { status: 200, json: this.current ? [this.current] : [], headers };
		if (r.method === 'GET' && r.path.includes('/time-entries')) return { status: 200, json: this.entries, headers };
		if (r.method === 'GET' && r.path.includes('/projects')) return { status: 200, json: [{ id: PROJ_DOCS, name: 'Docs', color: '#03A9F4', archived: false, workspaceId: WS }, { id: PROJ_CODE, name: 'Code', color: '#8BC34A', archived: false, workspaceId: WS }], headers };
		if (r.method === 'GET' && r.path.includes('/tags')) return { status: 200, json: [{ id: TAG_X, name: 'x', workspaceId: WS, archived: false }], headers };
		if (r.method === 'POST') {
			const e = wireEntry(this.newId(), String(body.start), typeof body.end === 'string' ? body.end : null, { description: body.description ?? '', projectId: body.projectId ?? null, tagIds: body.tagIds ?? [] });
			this.entries.push(e);
			return { status: 201, json: e, headers };
		}
		if (r.method === 'PATCH') {
			const e = this.entries.find((x) => (x.timeInterval as { end: unknown }).end === null);
			if (e) (e.timeInterval as { end: unknown }).end = body.end ?? this.stopAt;
			return { status: 200, json: e ?? null, headers };
		}
		if (r.method === 'PUT') {
			const id = /time-entries\/([0-9a-f]+)/.exec(r.path)?.[1];
			const e = this.entries.find((x) => x.id === id);
			if (e) Object.assign(e, { description: body.description, projectId: body.projectId ?? null, timeInterval: { start: body.start, end: body.end ?? null, duration: null } });
			return { status: 200, json: e ?? null, headers };
		}
		if (r.method === 'DELETE') return { status: 204, json: null, headers };
		return { status: 404, json: { message: 'no such route' }, headers };
	}
}
