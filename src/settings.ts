import { App, PluginSettingTab, Setting } from "obsidian";
import type GitDiffsPlugin from "./main";

export interface GitDiffsSettings {
	baseRef: string;
	includeUntracked: boolean;
	autoRefresh: boolean;
	autoRefreshDelay: number;
	largeFileThresholdBytes: number;
	ignorePaths: string[];
	diffStyle: "unified" | "split";
	overflow: "scroll" | "wrap";
}

export const DEFAULT_SETTINGS: GitDiffsSettings = {
	baseRef: "HEAD",
	includeUntracked: true,
	autoRefresh: true,
	autoRefreshDelay: 500,
	largeFileThresholdBytes: 500_000,
	ignorePaths: [".obsidian/"],
	diffStyle: "unified",
	overflow: "scroll",
};

export class GitDiffsSettingTab extends PluginSettingTab {
	plugin: GitDiffsPlugin;

	constructor(app: App, plugin: GitDiffsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Base ref")
			.setDesc("Git ref to diff against (e.g. HEAD, main, origin/develop).")
			.addText((text) =>
				text
					.setPlaceholder("HEAD")
					.setValue(this.plugin.settings.baseRef)
					.onChange(async (value) => {
						this.plugin.settings.baseRef = value.trim() || "HEAD";
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Include untracked files")
			.setDesc("Show diffs for files not yet tracked by git.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.includeUntracked).onChange(async (value) => {
					this.plugin.settings.includeUntracked = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Ignore paths")
			.setDesc(
				"One path prefix per line. Any file whose path starts with a prefix is skipped.",
			)
			.addTextArea((text) =>
				text
					.setPlaceholder(".obsidian/")
					.setValue(this.plugin.settings.ignorePaths.join("\n"))
					.onChange(async (value) => {
						this.plugin.settings.ignorePaths = value
							.split("\n")
							.map((l) => l.trim())
							.filter(Boolean);
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Auto-refresh on file changes")
			.setDesc("Re-run git diff when files in the vault change.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoRefresh).onChange(async (value) => {
					const wasOff = !this.plugin.settings.autoRefresh;
					this.plugin.settings.autoRefresh = value;
					await this.plugin.saveSettings();
					this.plugin.rebuildAutoRefresh();
					if (value && wasOff) this.plugin.refreshAllViews();
				}),
			);

		new Setting(containerEl)
			.setName("Auto-refresh delay (ms)")
			.setDesc("Debounce window before refreshing after a file change.")
			.addText((text) =>
				text
					.setPlaceholder("500")
					.setValue(String(this.plugin.settings.autoRefreshDelay))
					.onChange(async (value) => {
						const n = Number(value);
						this.plugin.settings.autoRefreshDelay =
							Number.isFinite(n) && n >= 0 ? n : 500;
						await this.plugin.saveSettings();
						this.plugin.rebuildAutoRefresh();
					}),
			);

		new Setting(containerEl)
			.setName("Large file threshold (bytes)")
			.setDesc(
				"Files larger than this (old or new side) show a click-to-load placeholder instead of auto-rendering.",
			)
			.addText((text) =>
				text
					.setPlaceholder("500000")
					.setValue(String(this.plugin.settings.largeFileThresholdBytes))
					.onChange(async (value) => {
						const n = Number(value);
						this.plugin.settings.largeFileThresholdBytes =
							Number.isFinite(n) && n >= 0 ? n : 500_000;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Default diff style")
			.setDesc("Layout for new views. Each view's header can override.")
			.addDropdown((dd) =>
				dd
					.addOption("unified", "Unified")
					.addOption("split", "Split")
					.setValue(this.plugin.settings.diffStyle)
					.onChange(async (value) => {
						this.plugin.settings.diffStyle = value as "unified" | "split";
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Default line overflow")
			.setDesc("How long lines are handled in new views.")
			.addDropdown((dd) =>
				dd
					.addOption("scroll", "Scroll")
					.addOption("wrap", "Wrap")
					.setValue(this.plugin.settings.overflow)
					.onChange(async (value) => {
						this.plugin.settings.overflow = value as "scroll" | "wrap";
						await this.plugin.saveSettings();
					}),
			);
	}
}
