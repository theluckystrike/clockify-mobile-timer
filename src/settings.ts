import { Notice, Platform, PluginSettingTab, type SettingDefinitionItem } from 'obsidian';
import { sponsorsSettingItems } from './license/github-obsidian';
import { PRO_UI, isPro } from './pro';
import { HOURLY_CAP, formatWait } from './logic';
import type ClockifyMobileTimerPlugin from './main';
import { helloSettingItems } from './hello/settings';

export interface ClockifyMobileTimerSettings {
	/** Name of the secret in Obsidian secret storage. The token itself is never in data.json. */
	tokenSecretId: string;
	/** Free: one default project for every timer, as a project id text. Empty means no project. */
	defaultProjectId: string;
	showStatusBar: boolean;
	/** True: the title of the open note is the description of a timer that starts from that note, and Clockify gets it. */
	useNoteTitle: boolean;
	/** Minutes before the timer panel asks Clockify again. */
	refreshMinutes: number;
	weekStart: 'monday' | 'sunday';
}

export const REFRESH_MIN = 5;
export const REFRESH_MAX = 60;
export const DEFAULT_SECRET_ID = 'clockify-mobile-timer-api-token';

export const DEFAULT_SETTINGS: ClockifyMobileTimerSettings = {
	tokenSecretId: DEFAULT_SECRET_ID,
	defaultProjectId: '',
	showStatusBar: true,
	useNoteTitle: true,
	refreshMinutes: 10,
	weekStart: 'monday',
};

/** Fills gaps and drops bad values from saved data, so old or hand-edited data.json never breaks the plugin. */
export function normalizeSettings(saved: Partial<ClockifyMobileTimerSettings> | null | undefined): ClockifyMobileTimerSettings {
	const s = saved ?? {};
	const minutes = typeof s.refreshMinutes === 'number' && Number.isFinite(s.refreshMinutes) ? Math.round(s.refreshMinutes) : DEFAULT_SETTINGS.refreshMinutes;
	const id = typeof s.tokenSecretId === 'string' && /^[a-z0-9-]+$/.test(s.tokenSecretId) ? s.tokenSecretId : DEFAULT_SETTINGS.tokenSecretId;
	return {
		tokenSecretId: id,
		defaultProjectId: typeof s.defaultProjectId === 'string' && /^[0-9a-f]{0,24}$/i.test(s.defaultProjectId) ? s.defaultProjectId : '',
		showStatusBar: typeof s.showStatusBar === 'boolean' ? s.showStatusBar : DEFAULT_SETTINGS.showStatusBar,
		useNoteTitle: typeof s.useNoteTitle === 'boolean' ? s.useNoteTitle : DEFAULT_SETTINGS.useNoteTitle,
		refreshMinutes: Math.min(REFRESH_MAX, Math.max(REFRESH_MIN, minutes)),
		weekStart: s.weekStart === 'sunday' ? 'sunday' : 'monday',
	};
}

export class ClockifyMobileTimerSettingTab extends PluginSettingTab {
	plugin: ClockifyMobileTimerPlugin;

	constructor(app: ConstructorParameters<typeof PluginSettingTab>[0], plugin: ClockifyMobileTimerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getControlValue(key: string): unknown {
		return (this.plugin.settings as unknown as Record<string, unknown>)[key];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		this.plugin.settings = normalizeSettings({ ...this.plugin.settings, [key]: value });
		await this.plugin.persist();
		this.plugin.refreshChrome();
	}

	private budgetText(): string {
		const svc = this.plugin.service;
		const wait = svc.waitMs();
		const left = `Plugin requests left this hour: ${svc.requestsLeft()} of ${HOURLY_CAP}. This is the plugin's own cap, not a Clockify limit.`;
		return wait > 0 ? `${left} The plugin waits ${formatWait(wait)} before the next request.` : left;
	}

	private projectOptions(): Record<string, string> {
		const out: Record<string, string> = { '': 'No project' };
		for (const p of this.plugin.service.state.projects) if (p.active) out[String(p.id)] = p.name;
		return out;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		// The product rows, then the "More from NoteMods" card (packages/hello).
		return [...this.productSettingDefinitions(), ...helloSettingItems()];
	}

	productSettingDefinitions(): SettingDefinitionItem[] {
		return [
			...(this.plugin.pro ? sponsorsSettingItems(this.plugin.pro, PRO_UI) : []),
			{
				name: 'Clockify API key',
				desc: 'Find it on clockify.me under Profile settings, API, Generate. If your workspace is on a subdomain, generate the key there. It is kept in Obsidian secret storage, not in a note or in data.json.',
				control: { type: 'secret', key: 'tokenSecretId', defaultValue: DEFAULT_SECRET_ID },
			},
			{
				name: 'Check connection',
				desc: 'Asks Clockify who you are. This uses 1 request.',
				action: () => void this.plugin.checkConnection().then(() => this.update()),
			},
			{
				name: 'Default project',
				desc: 'Every timer you start gets this project. Pro lets you pick a project for each timer and set one in the properties of a note. Load the list first.',
				control: { type: 'dropdown', key: 'defaultProjectId', defaultValue: '', options: this.projectOptions() },
			},
			{
				name: 'Load projects',
				desc: 'Gets your projects from Clockify. This uses 1 request. The list is kept for 6 hours.',
				action: () => void this.plugin.service.loadProjects(true).then((p) => {
					new Notice(`${p.length} projects loaded.`);
					this.update();
				}),
			},
			{
				name: 'Show timer in the status bar',
				desc: 'The status bar does not exist on phones and tablets. There the timer panel and the ribbon button show the timer.',
				visible: () => Platform.isDesktop,
				control: { type: 'toggle', key: 'showStatusBar', defaultValue: true },
			},
			{
				name: 'Use the note title as the description',
				desc: 'On: when you start a timer from a note, the title of the open note is the description of the time entry, and it is sent to Clockify. The Start window offers it, and "Start timer for this note" sends it at once. Off: no note title is sent, unless you type it.',
				control: { type: 'toggle', key: 'useNoteTitle', defaultValue: true },
			},
			{
				name: 'Ask Clockify again after',
				desc: `Minutes before the panel asks Clockify for fresh data when you open the app again, from ${REFRESH_MIN} to ${REFRESH_MAX}. A longer wait uses fewer of the plugin's 120 requests an hour.`,
				control: { type: 'slider', key: 'refreshMinutes', defaultValue: DEFAULT_SETTINGS.refreshMinutes, min: REFRESH_MIN, max: REFRESH_MAX, step: 5 },
			},
			{
				name: 'Week starts on',
				desc: 'Used by the week range in the report code block.',
				control: { type: 'dropdown', key: 'weekStart', defaultValue: 'monday', options: { monday: 'Monday', sunday: 'Sunday' } },
			},
			{ name: 'Request budget', desc: this.budgetText() },
			{
				name: 'Pro features',
				desc: isPro()
					? 'Pro is on: report code block, edit and delete past entries, project and tag pickers, a project for each note, and the offline queue.'
					: 'Free version: start, stop and switch the timer, the running timer and the day total, and one default project. Pro adds the report code block, edit and delete of past entries, project and tag pickers, a project for each note, and the offline queue.',
			},
		];
	}
}
