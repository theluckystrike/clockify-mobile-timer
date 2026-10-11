import { Modal, Setting, type App } from 'obsidian';
import { parseTags, type Project, type TimeEntry } from './logic';
import { isPro } from './pro';
import type { StartRequest } from './service';

export interface StartModalOptions {
	title: string;
	description: string;
	projects: Project[];
	projectId: string | null;
	/** Name of the free default project, shown when Pro is off. */
	defaultProjectName: string;
	tagNames: string[];
	onSubmit: (req: StartRequest) => void;
}

/** Start or switch: a description and, with Pro, a project and tags. Enter starts the timer. */
export class StartModal extends Modal {
	private opts: StartModalOptions;
	private description: string;
	private projectId: string | null;
	private tagsText = '';

	constructor(app: App, opts: StartModalOptions) {
		super(app);
		this.opts = opts;
		this.description = opts.description;
		this.projectId = opts.projectId;
	}

	onOpen(): void {
		this.setTitle(this.opts.title);
		this.contentEl.addClass('tmt-modal');
		new Setting(this.contentEl).setName('Description').addText((t) => {
			t.setValue(this.description).setPlaceholder('What are you working on?').onChange((v) => (this.description = v));
			t.inputEl.addEventListener('keydown', (e) => {
				if (e.key === 'Enter') this.submit();
			});
			window.setTimeout(() => t.inputEl.focus(), 50);
		});
		if (isPro()) this.proRows();
		else this.freeRow();
		new Setting(this.contentEl).addButton((b) => b.setButtonText('Start').setCta().onClick(() => this.submit())).addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()));
	}

	private freeRow(): void {
		const name = this.opts.defaultProjectName;
		new Setting(this.contentEl).setName('Project').setDesc(`${name ? `Default: ${name}.` : 'No default project.'} Pro lets you pick a project and tags for each timer.`);
	}

	private proRows(): void {
		new Setting(this.contentEl).setName('Project').addDropdown((d) => {
			d.addOption('', 'No project');
			for (const p of this.opts.projects) if (p.active) d.addOption(String(p.id), p.name);
			d.setValue(this.projectId === null ? '' : String(this.projectId));
			d.onChange((v) => (this.projectId = v === '' ? null : v));
		});
		new Setting(this.contentEl).setName('Tags').setDesc('Separate with commas.').addText((t) => {
			t.setPlaceholder('Review, deep work').onChange((v) => (this.tagsText = v));
			const list = t.inputEl.createEl('datalist');
			list.id = 'tmt-tag-list';
			for (const n of this.opts.tagNames.slice(0, 100)) list.createEl('option', { value: n });
			t.inputEl.setAttribute('list', list.id);
		});
	}

	private submit(): void {
		const req: StartRequest = { description: this.description.trim(), projectId: this.projectId, tags: isPro() ? parseTags(this.tagsText) : [] };
		this.close();
		this.opts.onSubmit(req);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export interface EditResult {
	description: string;
	projectId: string | null;
	startMs: number;
	stopMs: number;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');
const timeText = (ms: number): string => `${pad2(new Date(ms).getHours())}:${pad2(new Date(ms).getMinutes())}`;

/** Local time "HH:mm" on the day of dayMs, as ms. Null for a bad time. */
export function timeOnDay(dayMs: number, text: string): number | null {
	const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
	if (!m) return null;
	const h = Number(m[1]);
	const min = Number(m[2]);
	if (h > 23 || min > 59) return null;
	const d = new Date(dayMs);
	d.setHours(h, min, 0, 0);
	return d.getTime();
}

/** Pro: edit the description, project and times of a finished entry, or delete it. */
export class EditModal extends Modal {
	private entry: TimeEntry;
	private projects: Project[];
	private onSave: (r: EditResult) => void;
	private onDelete: () => void;
	private description: string;
	private projectId: string | null;
	private startText: string;
	private stopText: string;
	private confirm = false;

	constructor(app: App, entry: TimeEntry, projects: Project[], onSave: (r: EditResult) => void, onDelete: () => void) {
		super(app);
		this.entry = entry;
		this.projects = projects;
		this.onSave = onSave;
		this.onDelete = onDelete;
		this.description = entry.description ?? '';
		this.projectId = entry.project_id;
		this.startText = timeText(Date.parse(entry.start));
		this.stopText = entry.stop ? timeText(Date.parse(entry.stop)) : '';
	}

	onOpen(): void {
		this.setTitle('Edit time entry');
		this.contentEl.addClass('tmt-modal');
		new Setting(this.contentEl).setName('Description').addText((t) => t.setValue(this.description).onChange((v) => (this.description = v)));
		new Setting(this.contentEl).setName('Project').addDropdown((d) => {
			d.addOption('', 'No project');
			for (const p of this.projects) if (p.active || p.id === this.projectId) d.addOption(String(p.id), p.name);
			d.setValue(this.projectId === null ? '' : String(this.projectId));
			d.onChange((v) => (this.projectId = v === '' ? null : v));
		});
		new Setting(this.contentEl).setName('Start').addText((t) => {
			t.inputEl.type = 'time';
			t.setValue(this.startText).onChange((v) => (this.startText = v));
		});
		new Setting(this.contentEl).setName('Stop').addText((t) => {
			t.inputEl.type = 'time';
			t.setValue(this.stopText).onChange((v) => (this.stopText = v));
		});
		const err = this.contentEl.createDiv({ cls: 'tmt-error' });
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText('Save').setCta().onClick(() => this.save(err)))
			.addButton((b) =>
				b.setButtonText('Delete').setDestructive().onClick(() => {
					if (!this.confirm) {
						this.confirm = true;
						b.setButtonText('Select again to delete');
						return;
					}
					this.close();
					this.onDelete();
				}),
			);
	}

	private save(err: HTMLElement): void {
		const startDay = Date.parse(this.entry.start);
		const startMs = timeOnDay(startDay, this.startText);
		let stopMs = timeOnDay(startDay, this.stopText);
		if (startMs === null || stopMs === null) {
			err.setText('Enter the start and stop time as hours and minutes.');
			return;
		}
		// A stop time before the start time means the entry ends after midnight.
		if (stopMs <= startMs) stopMs += 86_400_000;
		this.close();
		this.onSave({ description: this.description.trim(), projectId: this.projectId, startMs, stopMs });
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
