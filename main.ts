import { App, FileSystemAdapter, Notice, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, TFolder } from 'obsidian';
import { simpleGit, SimpleGit } from 'simple-git';
import type { SimpleGitOptions } from 'simple-git';

type NoticeLevelSetting = 'ALL' | 'WARNING' | 'ERROR';
type NoticeSeverity = 'INFO' | 'WARNING' | 'ERROR';
type AutoSyncMode = 'off' | 'interval' | 'on-save';

interface GHSyncSettings {
	remoteURL: string;
	gitLocation: string;
	syncinterval: number;
	autoSyncMode: AutoSyncMode;
	isSyncOnLoad: boolean;
	checkStatusOnLoad: boolean;
	noticeLevel: NoticeLevelSetting;
	showSyncSuccessNotice: boolean;
}

const DEFAULT_SETTINGS: GHSyncSettings = {
	remoteURL: '',
	gitLocation: '',
	syncinterval: 0,
	autoSyncMode: 'off',
	isSyncOnLoad: false,
	checkStatusOnLoad: true,
	noticeLevel: 'ALL',
	showSyncSuccessNotice: true,
};

const SAVE_SYNC_DEBOUNCE_MS = 2000;

export default class GHSyncPlugin extends Plugin {
	settings: GHSyncSettings;
	private syncPromise: Promise<void> | null = null;
	private intervalTimer: number | null = null;
	private saveSyncTimer: number | null = null;
	private saveSyncPending = false;

	private shouldShowNotice(severity: NoticeSeverity): boolean {
		switch (this.settings.noticeLevel) {
			case 'ERROR':
				return severity === 'ERROR';
			case 'WARNING':
				return severity !== 'INFO';
			default:
				return true;
		}
	}

	private showNotice(message: unknown, severity: NoticeSeverity, timeout?: number): void {
		if (this.shouldShowNotice(severity)) {
			new Notice(message instanceof Error ? message.message : String(message), timeout);
		}
	}

	private createGit(): SimpleGit {
		if (!(this.app.vault.adapter instanceof FileSystemAdapter)) {
			throw new Error('GitHub Sync requires a desktop vault stored on disk.');
		}
		const location = this.settings.gitLocation.trim().replace(/[\\/]+$/, '');
		const binary = location ? location + '/' + (process.platform === 'win32' ? 'git.exe' : 'git') : 'git';
		const options: Partial<SimpleGitOptions> = {
			baseDir: this.app.vault.adapter.getBasePath(),
			binary,
			maxConcurrentProcesses: 1,
			trimmed: false,
		};
		return simpleGit(options);
	}

	// Git cannot store an empty directory. A placeholder makes the directory part of the commit.
	private async trackEmptyFolders(git: SimpleGit): Promise<void> {
		const folders = this.app.vault.getAllLoadedFiles().filter(
			(file): file is TFolder => file instanceof TFolder && file.path.length > 0 && !file.path.split('/').includes('.git')
		);
		const placeholders: string[] = [];
		for (const folder of folders) {
			// Subfolders do not count as files. Keep even a parent containing only empty folders.
			if (folder.children.some(child => child instanceof TFile && child.name !== '.gitkeep')) {
				continue;
			}
			const path = folder.path + '/.gitkeep';
			if (!(await this.app.vault.adapter.exists(path))) {
				placeholders.push(path);
			}
		}
		if (placeholders.length === 0) {
			return;
		}

		// Never create placeholders inside folders excluded by the vault's gitignore rules.
		const ignored = new Set(await git.checkIgnore(placeholders));
		for (const path of placeholders) {
			if (!ignored.has(path)) {
				await this.app.vault.create(path, '');
			}
		}
	}

	async SyncNotes(): Promise<void> {
		if (this.syncPromise) {
			return this.syncPromise;
		}
		const sync = this.performSync();
		this.syncPromise = sync;
		try {
			await sync;
		} finally {
			this.syncPromise = null;
			if (this.saveSyncPending && this.settings.autoSyncMode === 'on-save') {
				this.saveSyncPending = false;
				this.scheduleSaveSync();
			}
		}
	}

	private async performSync(): Promise<void> {
		const remote = this.settings.remoteURL.trim();
		if (!remote) {
			this.showNotice('GitHub Sync: configure a remote URL before syncing.', 'ERROR', 10000);
			return;
		}

		let git: SimpleGit;
		try {
			git = this.createGit();
			await git.status();
		} catch {
			this.showNotice('GitHub Sync: vault is not a Git repository or Git could not be found.', 'ERROR', 10000);
			return;
		}

		try {
			const before = await git.status();
			if (before.conflicted.length > 0) {
				this.showConflicts(before.conflicted);
				return;
			}

			await this.trackEmptyFolders(git);
			await git.add(['--all']);
			if (!(await git.status()).isClean()) {
				const now = new Date();
				const hostname = require('os').hostname();
				const msg = hostname + ' ' + now.getFullYear() + '-' + (now.getMonth() + 1) + '-' + now.getDate() + ':' + now.getHours() + ':' + now.getMinutes() + ':' + now.getSeconds();
				await git.commit(msg);
			}

			const origin = (await git.getRemotes(true)).find(entry => entry.name === 'origin');
			if (!origin) {
				await git.addRemote('origin', remote);
			} else if (origin.refs.fetch !== remote || origin.refs.push !== remote) {
				await git.remote(['set-url', 'origin', remote]);
			}

			await git.fetch('origin');
			await git.pull('origin', 'main', { '--no-rebase': null });
			// Also retry commits from an earlier failed push, even if this run has no local changes.
			await git.push('origin', 'main', ['-u']);
			if (this.settings.showSyncSuccessNotice) {
				this.showNotice('GitHub Sync successful.', 'INFO');
			}
		} catch (error) {
			const status = await git.status().catch(() => null);
			if (status && status.conflicted.length > 0) {
				this.showConflicts(status.conflicted);
			} else {
				this.showNotice(error, 'ERROR', 10000);
			}
		}
	}

	private showConflicts(paths: string[]): void {
		this.showNotice('GitHub Sync: resolve merge conflicts before syncing again:\n' + paths.join('\n'), 'WARNING', 10000);
		for (const path of paths) {
			void this.app.workspace.openLinkText('', path, true);
		}
	}

	private async CheckStatusOnStart(): Promise<void> {
		try {
			const git = this.createGit();
			await git.branch({ '--set-upstream-to': 'origin/main' });
			const status = await git.fetch().status();
			if (status.behind > 0) {
				if (this.settings.isSyncOnLoad) {
					void this.SyncNotes();
				} else {
					this.showNotice('GitHub Sync: ' + status.behind + ' commits behind remote. Click the ribbon icon to sync.', 'WARNING');
				}
			} else {
				this.showNotice('GitHub Sync: up to date with remote.', 'INFO');
			}
		} catch {
			// Initial setup may not have an origin/main tracking branch yet.
		}
	}

	private onVaultChange(file: TAbstractFile): void {
		if (this.settings.autoSyncMode !== 'on-save' || file.name === '.gitkeep' || file.path.startsWith('.git/')) {
			return;
		}
		this.scheduleSaveSync();
	}

	private scheduleSaveSync(): void {
		if (this.saveSyncTimer !== null) {
			window.clearTimeout(this.saveSyncTimer);
		}
		this.saveSyncTimer = window.setTimeout(() => {
			this.saveSyncTimer = null;
			if (this.syncPromise) {
				this.saveSyncPending = true;
			} else {
				void this.SyncNotes();
			}
		}, SAVE_SYNC_DEBOUNCE_MS);
	}

	refreshAutoSync(): void {
		if (this.intervalTimer !== null) {
			window.clearInterval(this.intervalTimer);
			this.intervalTimer = null;
		}
		if (this.saveSyncTimer !== null) {
			window.clearTimeout(this.saveSyncTimer);
			this.saveSyncTimer = null;
		}
		this.saveSyncPending = false;
		if (this.settings.autoSyncMode === 'interval' && Number.isFinite(this.settings.syncinterval) && this.settings.syncinterval > 0) {
			this.intervalTimer = window.setInterval(() => { void this.SyncNotes(); }, this.settings.syncinterval * 60 * 1000);
		}
	}

	async onload(): Promise<void> {
		await this.loadSettings();
		const ribbonIconEl = this.addRibbonIcon('github', 'Sync with Remote', () => { void this.SyncNotes(); });
		ribbonIconEl.addClass('gh-sync-ribbon');
		this.addCommand({ id: 'github-sync-command', name: 'Sync with Remote', callback: () => { void this.SyncNotes(); } });
		this.addSettingTab(new GHSyncSettingTab(this.app, this));

		// Register after the initial vault load so initial create events do not trigger a sync.
		this.app.workspace.onLayoutReady(() => {
			this.registerEvent(this.app.vault.on('modify', file => this.onVaultChange(file)));
			this.registerEvent(this.app.vault.on('create', file => this.onVaultChange(file)));
			this.registerEvent(this.app.vault.on('delete', file => this.onVaultChange(file)));
			this.registerEvent(this.app.vault.on('rename', file => this.onVaultChange(file)));
		});
		this.refreshAutoSync();
		if (this.settings.checkStatusOnLoad) {
			void this.CheckStatusOnStart();
		}
	}

	onunload(): void {
		if (this.intervalTimer !== null) {
			window.clearInterval(this.intervalTimer);
		}
		if (this.saveSyncTimer !== null) {
			window.clearTimeout(this.saveSyncTimer);
		}
	}

	async loadSettings(): Promise<void> {
		const saved = (await this.loadData()) as Partial<GHSyncSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
		if ((this.settings.noticeLevel as string) === 'WARNINGS') {
			this.settings.noticeLevel = 'WARNING';
		}
		// Existing users with an interval configured keep that behavior after upgrading.
		if (!saved || !saved.autoSyncMode) {
			this.settings.autoSyncMode = this.settings.syncinterval > 0 ? 'interval' : 'off';
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}

class GHSyncSettingTab extends PluginSettingTab {
	plugin: GHSyncPlugin;

	constructor(app: App, plugin: GHSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		const howto = containerEl.createEl("div", { cls: "howto" });
		howto.createEl("div", { text: "How to use this plugin", cls: "howto_title" });
		howto.createEl("small", { text: "Grab your GitHub repository's HTTPS or SSH url and paste it into the settings here. If you're not authenticated, the first sync with this plugin should prompt you to authenticate. If you've already setup SSH on your device with GitHub, you won't need to authenticate - just paste your repo's SSH url into the settings here.", cls: "howto_text" });
		howto.createEl("br");
        const linkEl = howto.createEl('p');
        linkEl.createEl('span', { text: 'See the ' });
        linkEl.createEl('a', { href: 'https://github.com/fraa2a/Obsidian-GitHub-Sync#readme', text: 'README' });
        linkEl.createEl('span', { text: ' for more information and troubleshooting.' });

		new Setting(containerEl)
			.setName('Remote URL')
			.setDesc('')
			.addText(text => text
				.setPlaceholder('')
				.setValue(this.plugin.settings.remoteURL)
				.onChange(async (value) => {
					this.plugin.settings.remoteURL = value;
					await this.plugin.saveSettings();
				})
        	.inputEl.addClass('my-plugin-setting-text'));

		new Setting(containerEl)
			.setName('git binary location')
			.setDesc('This is optional! Set this only if git is not findable via your system PATH, then provide its location here. See README for more info.')
			.addText(text => text
				.setPlaceholder('')
				.setValue(this.plugin.settings.gitLocation)
				.onChange(async (value) => {
					this.plugin.settings.gitLocation = value;
					await this.plugin.saveSettings();
				})
        	.inputEl.addClass('my-plugin-setting-text2'));

		new Setting(containerEl)
			.setName('Notice level')
			.setDesc('Choose which GitHub Sync notices are shown in the Obsidian UI.')
			.addDropdown((dropdown) => dropdown
				.addOption('ALL', 'ALL')
				.addOption('WARNING', 'WARNING')
				.addOption('ERROR', 'ERROR')
				.setValue(this.plugin.settings.noticeLevel)
				.onChange(async (value: NoticeLevelSetting) => {
					this.plugin.settings.noticeLevel = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Hide Success Message')
			.setDesc('Hide the single success notice shown when a sync finishes successfully.')
			.addToggle((toggle) => toggle
				.setValue(!this.plugin.settings.showSyncSuccessNotice)
				.onChange(async (value) => {
					this.plugin.settings.showSyncSuccessNotice = !value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Check status on startup')
			.setDesc('Check to see if you are behind remote when you start Obsidian.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.checkStatusOnLoad)
				.onChange(async (value) => {
					this.plugin.settings.checkStatusOnLoad = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Auto sync on startup')
			.setDesc('Automatically sync with remote when you start Obsidian if there are unsynced changes.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.isSyncOnLoad)
				.onChange(async (value) => {
					this.plugin.settings.isSyncOnLoad = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Automatic sync mode')
			.setDesc('Choose interval sync or sync when a file is saved, created, renamed, or deleted. Save sync groups rapid changes into one commit.')
			.addDropdown(dropdown => dropdown
				.addOption('off', 'Disabled')
				.addOption('interval', 'Every N minutes')
				.addOption('on-save', 'On file save')
				.setValue(this.plugin.settings.autoSyncMode)
				.onChange(async (value: AutoSyncMode) => {
					this.plugin.settings.autoSyncMode = value;
					await this.plugin.saveSettings();
					this.plugin.refreshAutoSync();
					this.display();
				}));

		if (this.plugin.settings.autoSyncMode === 'interval') {
			new Setting(containerEl)
				.setName('Auto sync interval (minutes)')
				.setDesc('How often to sync. Set a positive number. Changes apply immediately.')
				.addText(text => text
					.setValue(String(this.plugin.settings.syncinterval))
					.onChange(async value => {
						const minutes = Number(value);
						this.plugin.settings.syncinterval = Number.isFinite(minutes) && minutes > 0 ? minutes : 0;
						await this.plugin.saveSettings();
						this.plugin.refreshAutoSync();
					}));
		}
	}
}
