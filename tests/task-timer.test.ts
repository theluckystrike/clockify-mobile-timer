import { describe, expect, it } from 'vitest';
import { ClockifyClient } from '../src/client';
import { FakeClockify } from './fake-clockify';
import { taskDescription } from '../src/logic';
import { TimerService, emptyState } from '../src/service';

const T0 = Date.parse('2026-10-10T08:00:00Z');

function wire() {
	const fake = new FakeClockify();
	const client = new ClockifyClient({ getToken: () => 'secret-key-123', http: fake.http, now: () => T0, onBudget: () => undefined });
	const svc = new TimerService(
		{ client, now: () => T0, tzOffsetMin: () => 0, isPro: () => false, hasToken: () => true, notify: () => undefined, save: () => undefined, ttlMs: () => 600_000, weekStart: () => 1 },
		emptyState(),
	);
	return { svc, calls: fake.calls };
}

describe('start timer for this task', () => {
	it('sends the cleaned task line as the description and nothing from the rest of the note', async () => {
		const { svc, calls } = wire();
		await svc.start({ description: taskDescription('- [ ] Email [[Alice Smith]] about the invoice \u{1F4C5} 2026-10-31'), projectId: null, tags: [] });
		const post = calls.find((c) => c.method === 'POST');
		expect(post?.body && JSON.parse(post.body)).toMatchObject({ description: 'Email Alice Smith about the invoice' });
		expect(JSON.stringify(calls.map((c) => c.body ?? ''))).not.toContain('2026-10-31');
	});

	it('a second task stops the first timer and starts the next, in 2 requests', async () => {
		const { svc, calls } = wire();
		await svc.start({ description: taskDescription('- [ ] laundry'), projectId: null, tags: [] });
		const before = calls.length;
		await svc.start({ description: taskDescription('- [ ] dishes'), projectId: null, tags: [] });
		const sent = calls.slice(before).map((c) => c.method);
		expect(sent).toEqual(['PATCH', 'POST']);
		expect(svc.current()?.description).toBe('dishes');
	});

	it('a line with no text gives an empty description, which the command refuses to start', () => {
		expect(taskDescription('- [ ] ')).toBe('');
	});

	it('the cut at 120 characters does not split an emoji into half a character', () => {
		const d = taskDescription(`- [ ] ${'a'.repeat(119)}\u{1F600} more`);
		expect(d).toBe(`${'a'.repeat(119)}\u{1F600}`);
		// encodeURIComponent throws on a lone surrogate.
		expect(() => encodeURIComponent(d)).not.toThrow();
	});
});
