import { ItemView, setIcon, type WorkspaceLeaf } from 'obsidian';
import { entrySeconds, formatClock, formatHours, formatWait, HOURLY_CAP, isLocalId } from './logic';
import { isPro } from './pro';
import type { TimeEntry } from './logic';
import type ClockifyMobileTimerPlugin from './main';

export const VIEW_ID = 'clockify-mobile-timer-panel';
const MAX_ROWS = 25;

const pad2 = (n: number): string => String(n).padStart(2, '0');
const hhmm = (ms: number): string => `${pad2(new Date(ms).getHours())}:${pad2(new Date(ms).getMinutes())}`;

/** The timer panel. It works on phone, tablet and desktop: the status bar does not exist on a phone, so the panel is the pill there. */
export class TimerView extends ItemView {
	private plugin: ClockifyMobileTimerPlugin;
	private clockEl: HTMLElement | null = null;
	private todayEl: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: ClockifyMobileTimerPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.navigation = false;
	}

	getViewType(): string {
		return VIEW_ID;
	}

	getDisplayText(): string {
		return 'Clockify timer';
	}

	getIcon(): string {
		return 'timer';
	}

	onOpen(): Promise<void> {
		this.contentEl.addClass('tmt-panel');
		this.addAction('refresh-cw', 'Refresh from Clockify', () => void this.plugin.service.refresh({ force: true }));
		this.render();
		void this.plugin.service.refresh({ background: true });
		return Promise.resolve();
	}

	/** Called each second by the plugin while the app is visible: updates the clock and the day total with no request. */
	tick(): void {
		const svc = this.plugin.service;
		const run = svc.current();
		if (run && this.clockEl) this.clockEl.setText(formatClock(entrySeconds(run, svc.deps.now())));
		if (this.todayEl) this.todayEl.setText(`Today ${formatHours(svc.todaySeconds())}`);
	}

	render(): void {
		const el = this.contentEl;
		el.empty();
		const svc = this.plugin.service;
		const run = svc.current();
		const status = svc.status();
		const pill = el.createDiv({ cls: `tmt-pill tmt-${status}` });
		pill.createSpan({ cls: 'tmt-dot' });
		pill.createSpan({ cls: 'tmt-pill-text', text: this.plugin.pillText() });
		this.clockEl = el.createDiv({ cls: 'tmt-clock', text: run ? formatClock(entrySeconds(run, svc.deps.now())) : '0:00:00' });
		this.todayEl = el.createDiv({ cls: 'tmt-today', text: `Today ${formatHours(svc.todaySeconds())}` });
		this.buttons(el, run !== null);
		this.meta(el);
		this.list(el);
	}

	private buttons(el: HTMLElement, running: boolean): void {
		const row = el.createDiv({ cls: 'tmt-buttons' });
		if (running) {
			const stop = row.createEl('button', { cls: 'mod-warning', text: 'Stop' });
			stop.addEventListener('click', () => void this.plugin.service.stop());
			const sw = row.createEl('button', { text: 'Switch' });
			sw.addEventListener('click', () => this.plugin.openStart('Switch timer'));
		} else {
			const start = row.createEl('button', { cls: 'mod-cta', text: 'Start' });
			start.addEventListener('click', () => this.plugin.openStart('Start timer'));
		}
	}

	private meta(el: HTMLElement): void {
		const svc = this.plugin.service;
		const meta = el.createDiv({ cls: 'tmt-meta' });
		const wait = svc.waitMs();
		const status = svc.status();
		const parts = [`${svc.requestsLeft()} of ${HOURLY_CAP} plugin requests left this hour`];
		if (status === 'limited' && wait > 0) parts.unshift(`Waiting ${formatWait(wait)} before the next request`);
		if (status === 'offline') parts.unshift('No connection to Clockify');
		meta.createDiv({ text: parts.join('. ') + '.' });
		const queued = svc.pending();
		if (queued > 0) {
			const q = meta.createDiv({ cls: 'tmt-queue', text: `${queued} ${queued === 1 ? 'change waits' : 'changes wait'} to be sent. ` });
			q.createEl('a', { text: 'Send now', href: '#' }).addEventListener('click', (e) => {
				e.preventDefault();
				void svc.flushQueue();
			});
		}
	}

	private list(el: HTMLElement): void {
		const rows = this.plugin.service.todayEntries().filter((e) => e.stop !== null || isLocalId(e.id));
		const box = el.createDiv({ cls: 'tmt-list' });
		if (rows.length === 0) {
			box.createDiv({ cls: 'tmt-empty', text: 'No finished entries today.' });
			return;
		}
		for (const e of rows.slice(0, MAX_ROWS)) this.row(box, e);
		if (!isPro()) box.createDiv({ cls: 'tmt-hint', text: 'Pro: edit or delete an entry.' });
	}

	private row(box: HTMLElement, e: TimeEntry): void {
		const r = box.createDiv({ cls: 'tmt-row' });
		const start = Date.parse(e.start);
		r.createSpan({ cls: 'tmt-time', text: `${hhmm(start)}-${e.stop ? hhmm(Date.parse(e.stop)) : '...'}` });
		const dot = r.createSpan({ cls: 'tmt-proj-dot' });
		if (e.project_color) dot.setCssProps({ '--tmt-color': e.project_color });
		r.createSpan({ cls: 'tmt-desc', text: e.description || '(no description)' });
		r.createSpan({ cls: 'tmt-dur', text: formatHours(entrySeconds(e, this.plugin.service.deps.now())) });
		if (isPro() && !isLocalId(e.id)) {
			const b = r.createEl('button', { cls: 'clickable-icon tmt-edit', attr: { 'aria-label': 'Edit entry' } });
			setIcon(b, 'pencil');
			b.addEventListener('click', () => this.plugin.editEntry(e));
		}
	}
}
