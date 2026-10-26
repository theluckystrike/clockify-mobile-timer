// The clockify-report code block (Pro): hours by project, day or description for a range.
import { MarkdownRenderChild, type MarkdownPostProcessorContext } from 'obsidian';
import { decimalHours, formatHours, parseReportSpec, reportMarkdown } from './logic';
import { isPro, onProChange, proText } from './pro';
import type { Report } from './service';
import type ClockifyMobileTimerPlugin from './main';

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * Fills el with the report of a clockify-report block. The block draws again when Pro turns on or off, so a note that is
 * already open updates after sign in. Without Pro it shows a short note and sends no request.
 */
export function renderReport(plugin: ClockifyMobileTimerPlugin, source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
	el.addClass('tmt-report');
	const child = new MarkdownRenderChild(el);
	ctx.addChild(child);
	const draw = (): void => {
		el.empty();
		drawBlock(plugin, source, el);
	};
	child.register(onProChange(draw));
	draw();
}

function drawBlock(plugin: ClockifyMobileTimerPlugin, source: string, el: HTMLElement): void {
	const parsed = parseReportSpec(source);
	if ('error' in parsed) {
		el.createDiv({ cls: 'tmt-error', text: parsed.error });
		return;
	}
	if (!isPro()) {
		el.createDiv({ cls: 'tmt-locked', text: proText('The report block is a pro feature.') });
		return;
	}
	const body = el.createDiv({ text: 'Loading from Clockify...' });
	void plugin.service.report(parsed.spec).then((r) => {
		body.empty();
		if ('error' in r) body.createDiv({ cls: 'tmt-error', text: r.error });
		else drawReport(body, r, parsed.spec.title, () => void plugin.service.report(parsed.spec, true).then((n) => redraw(body, n, parsed.spec.title, plugin, parsed.spec)));
	});
}

function redraw(body: HTMLElement, r: Report | { error: string }, title: string, plugin: ClockifyMobileTimerPlugin, spec: { range: string; by: 'project' | 'day' | 'description' }): void {
	body.empty();
	if ('error' in r) body.createDiv({ cls: 'tmt-error', text: r.error });
	else drawReport(body, r, title, () => void plugin.service.report(spec, true).then((n) => redraw(body, n, title, plugin, spec)));
}

function drawReport(body: HTMLElement, r: Report, title: string, refresh: () => void): void {
	body.createEl('strong', { text: title || `Clockify, ${r.label}` });
	const table = body.createEl('table', { cls: 'tmt-report-table' });
	const head = table.createEl('thead').createEl('tr');
	head.createEl('th', { text: r.by === 'project' ? 'Project' : r.by === 'day' ? 'Day' : 'Description' });
	head.createEl('th', { text: 'Hours', cls: 'tmt-num' });
	const tbody = table.createEl('tbody');
	const max = Math.max(1, ...r.rows.map((x) => x.seconds));
	for (const row of r.rows) {
		const tr = tbody.createEl('tr');
		const cell = tr.createEl('td');
		const dot = cell.createSpan({ cls: 'tmt-proj-dot' });
		if (row.color) dot.setCssProps({ '--tmt-color': row.color });
		cell.createSpan({ text: row.key });
		const bar = cell.createDiv({ cls: 'tmt-bar' });
		bar.setCssProps({ '--tmt-width': `${Math.round((row.seconds / max) * 100)}%` });
		tr.createEl('td', { cls: 'tmt-num', text: decimalHours(row.seconds) });
	}
	const foot = table.createEl('tfoot').createEl('tr');
	foot.createEl('td', { text: `Total (${formatHours(r.totalSeconds)})` });
	foot.createEl('td', { cls: 'tmt-num', text: decimalHours(r.totalSeconds) });
	const when = new Date(r.updatedAt);
	const note = body.createDiv({ cls: 'tmt-report-note', text: `Updated ${pad2(when.getHours())}:${pad2(when.getMinutes())}${r.stale ? '. Clockify was not reachable, so this is the last copy' : ''}. ` });
	note.createEl('a', { text: 'Refresh', href: '#' }).addEventListener('click', (e) => {
		e.preventDefault();
		refresh();
	});
	note.createSpan({ text: ' | ' });
	note.createEl('a', { text: 'Copy as table', href: '#' }).addEventListener('click', (e) => {
		e.preventDefault();
		void navigator.clipboard.writeText(reportMarkdown(r.rows, r.by));
	});
}
