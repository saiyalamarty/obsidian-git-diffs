import {
	Debouncer,
	MarkdownView,
	Notice,
	Plugin,
	TAbstractFile,
	TFile,
	WorkspaceLeaf,
	debounce,
} from "obsidian";
import { type FileContents, parsePatchFiles } from "@pierre/diffs";
import { DEFAULT_SETTINGS, GitDiffsSettings, GitDiffsSettingTab } from "./settings";
import { DiffViewState, GIT_DIFFS_VIEW_TYPE, GitDiffsView } from "./view";
import { FileRenderSpec } from "./render";
import { FileExplorerDecorator } from "./explorer";
import { getGitDiff, getGitStatus, isGitRepo, readGitBlob, type StatusCode } from "./git";

export const GIT_DIFFS_REFRESH_EVENT = "git-diffs:refresh";

export default class GitDiffsPlugin extends Plugin {
	settings!: GitDiffsSettings;
	private pendingRefresh: Set<string> = new Set();
	private refreshDebouncer: Debouncer<[], void> | null = null;
	private inFlight: WeakMap<GitDiffsView, Promise<void>> = new WeakMap();
	private refreshCounter = 0;
	private explorerDecorator: FileExplorerDecorator | null = null;
	private statusMap: Map<string, StatusCode> = new Map();
	private statusBarEl: HTMLElement | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registerView(GIT_DIFFS_VIEW_TYPE, (leaf) => new GitDiffsView(leaf, this));

		this.addRibbonIcon("git-compare", "Show git diff for active file", () => {
			void this.showDiffForActiveFile();
		});

		this.addCommand({
			id: "show-diff-active-file",
			name: "Show diff for active file",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view?.file) return false;
				if (!checking) void this.showDiffForActiveFile();
				return true;
			},
		});

		this.addCommand({
			id: "show-diff-vault",
			name: "Show diff for entire vault",
			callback: () => {
				void this.showDiffForVault();
			},
		});

		this.addSettingTab(new GitDiffsSettingTab(this.app, this));

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFile)) return;
				menu.addItem((item) =>
					item
						.setTitle("Show git diff")
						.setIcon("git-compare")
						.onClick(() => void this.showDiffForFile(file)),
				);
			}),
		);

		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.addClass("git-diffs-status-bar");
		this.statusBarEl.addEventListener("click", () => void this.showDiffForVault());
		this.updateStatusBar();

		this.rebuildAutoRefresh();
		this.app.workspace.onLayoutReady(() => {
			this.registerVaultEvents();
			this.explorerDecorator = new FileExplorerDecorator(this.app);
			void this.refreshStatus();
			this.registerEvent(
				this.app.workspace.on("layout-change", () => this.explorerDecorator?.apply()),
			);
		});
	}

	onunload(): void {
		this.explorerDecorator?.clear();
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<GitDiffsSettings>,
		);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	rebuildAutoRefresh(): void {
		this.refreshDebouncer?.cancel();
		this.refreshDebouncer = debounce(
			() => this.emitRefresh(),
			this.settings.autoRefreshDelay,
			true,
		);
	}

	refreshAllViews(): void {
		const leaves = this.app.workspace.getLeavesOfType(GIT_DIFFS_VIEW_TYPE);
		for (const leaf of leaves) {
			const view = leaf.view as GitDiffsView;
			void this.refreshDiff(view, view.getPersistedFilePath());
		}
	}

	private registerVaultEvents(): void {
		const handler = (file: TAbstractFile) => {
			if (!this.settings.autoRefresh) return;
			if (this.isIgnoredPath(file.path)) return;
			this.pendingRefresh.add(file.path);
			this.refreshDebouncer?.();
		};

		this.registerEvent(this.app.vault.on("modify", handler));
		this.registerEvent(this.app.vault.on("create", handler));
		this.registerEvent(this.app.vault.on("delete", handler));
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (!this.settings.autoRefresh) return;
				if (this.isIgnoredPath(file.path) && this.isIgnoredPath(oldPath)) return;
				this.pendingRefresh.add(file.path);
				this.pendingRefresh.add(oldPath);
				this.refreshDebouncer?.();
			}),
		);
	}

	private isIgnoredPath(path: string): boolean {
		return this.settings.ignorePaths.some((prefix) => prefix && path.startsWith(prefix));
	}

	private emitRefresh(): void {
		const paths = Array.from(this.pendingRefresh);
		this.pendingRefresh.clear();
		this.app.workspace.trigger(GIT_DIFFS_REFRESH_EVENT, paths);
		void this.refreshStatus();
	}

	async refreshStatus(): Promise<void> {
		if (!this.explorerDecorator) return;
		const cwd = this.getVaultPath();
		if (!cwd || !(await isGitRepo(cwd))) {
			this.statusMap.clear();
			this.explorerDecorator.clear();
			return;
		}
		const filtered = new Map<string, StatusCode>();
		const full = await getGitStatus(cwd);
		for (const [path, code] of full) {
			if (this.isIgnoredPath(path)) continue;
			filtered.set(path, code);
		}
		this.statusMap = filtered;
		this.explorerDecorator.setStatus(filtered);
		this.updateStatusBar();
	}

	private updateStatusBar(): void {
		if (!this.statusBarEl) return;
		this.statusBarEl.empty();

		if (this.statusMap.size === 0) {
			this.statusBarEl.setAttribute("aria-label", "No uncommitted changes");
			this.statusBarEl.createSpan({ text: "✓", cls: "git-diffs-status-bar-clean" });
			return;
		}

		const counts: Record<StatusCode, number> = { M: 0, A: 0, D: 0, R: 0, U: 0, I: 0 };
		for (const code of this.statusMap.values()) counts[code]++;

		this.statusBarEl.setAttribute(
			"aria-label",
			`${this.statusMap.size} changed file(s) — click to show vault diff`,
		);

		const order: StatusCode[] = ["M", "A", "D", "R", "U"];
		for (const code of order) {
			if (counts[code] === 0) continue;
			this.statusBarEl.createSpan({
				text: `${code}${counts[code]}`,
				cls: `git-diffs-status-bar-item git-diffs-status-bar-${code}`,
			});
		}
	}

	private emptyState(title: string, message: string): DiffViewState {
		return {
			title,
			message,
			files: [],
			cacheKey: `msg:${message}`,
			diffStyle: this.settings.diffStyle,
			overflow: this.settings.overflow,
		};
	}

	async refreshDiff(view: GitDiffsView, filePath: string | null): Promise<void> {
		const existing = this.inFlight.get(view);
		if (existing) return existing;
		const p = this.runRefresh(view, filePath).finally(() => {
			this.inFlight.delete(view);
		});
		this.inFlight.set(view, p);
		return p;
	}

	private async runRefresh(view: GitDiffsView, filePath: string | null): Promise<void> {
		const id = ++this.refreshCounter;
		const t0 = performance.now();

		const cwd = this.getVaultPath();
		if (!cwd) {
			view.setDiff(this.emptyState("Git Diffs — error", "Could not resolve vault path"), filePath);
			return;
		}
		if (!(await isGitRepo(cwd))) {
			view.setDiff(this.emptyState("Git Diffs — error", "Vault is not a git repository"), filePath);
			return;
		}

		const title = filePath ? `Diff: ${filePath}` : "Diff: vault";

		try {
			const { patch } = await getGitDiff({
				cwd,
				baseRef: this.settings.baseRef,
				relativePath: filePath ?? undefined,
				includeUntracked: this.settings.includeUntracked,
			});

			if (!patch.trim()) {
				view.setDiff(this.emptyState(title, "No changes."), filePath);
				return;
			}

			const files = await this.enrichPatchFiles(cwd, patch);

			if (files.length === 0) {
				view.setDiff(this.emptyState(title, "No changes (all paths ignored)."), filePath);
				return;
			}

			const key = hashString(patch);
			if (view.getCacheKey() === key) {
				console.log(`[git-diffs] #${id} cache hit — skipping setDiff`);
				return;
			}

			view.setDiff(
				{
					title,
					message: null,
					files,
					cacheKey: key,
					diffStyle: view.getDiffStyle(),
					overflow: view.getOverflow(),
					stats: this.lastStats,
				},
				filePath,
			);
			console.log(
				`[git-diffs] #${id} ${files.length} files, ${(performance.now() - t0).toFixed(0)}ms`,
			);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			new Notice(`git diff failed: ${message}`);
			view.setDiff(this.emptyState("Git Diffs — error", message), filePath);
			console.error(`[git-diffs] #${id} failed`, err);
		}
	}

	lastStats: { additions: number; deletions: number } = { additions: 0, deletions: 0 };

	private async enrichPatchFiles(cwd: string, patch: string): Promise<FileRenderSpec[]> {
		const patches = parsePatchFiles(patch, undefined, false);
		const fileMetas = patches
			.flatMap((p) => p.files)
			.filter((m) => !this.isIgnoredPath(m.name) && !this.isIgnoredPath(m.prevName ?? m.name));

		let additions = 0;
		let deletions = 0;
		for (const meta of fileMetas) {
			for (const hunk of meta.hunks ?? []) {
				additions += hunk.additionLines ?? 0;
				deletions += hunk.deletionLines ?? 0;
			}
		}
		this.lastStats = { additions, deletions };

		const threshold = this.settings.largeFileThresholdBytes;

		const specs = await Promise.all(
			fileMetas.map(async (meta): Promise<FileRenderSpec> => {
				const isNew = meta.type === "new";
				const isDeleted = meta.type === "deleted";
				const oldPath = meta.prevName ?? meta.name;

				// Probe sizes without reading contents for large-file detection.
				const [oldSize, newSize] = await Promise.all([
					isNew ? 0 : this.probeBlobSize(cwd, this.settings.baseRef, oldPath),
					isDeleted ? 0 : this.probeWorkingSize(meta.name),
				]);

				if (oldSize > threshold || newSize > threshold) {
					return { name: meta.name, largeFile: { oldSize, newSize } };
				}

				const [oldContents, newContents] = await Promise.all([
					isNew ? "" : ((await readGitBlob(cwd, this.settings.baseRef, oldPath)) ?? ""),
					isDeleted ? "" : ((await this.readWorkingFile(meta.name)) ?? ""),
				]);

				return {
					name: meta.name,
					oldFile: { name: oldPath, contents: oldContents },
					newFile: { name: meta.name, contents: newContents },
				};
			}),
		);
		return specs;
	}

	async loadLargeFile(spec: FileRenderSpec): Promise<{ oldFile?: FileContents; newFile?: FileContents }> {
		const cwd = this.getVaultPath();
		if (!cwd) throw new Error("Could not resolve vault path");
		const oldPath = spec.name; // TODO: preserve prevName for renames on large files
		const [oldContents, newContents] = await Promise.all([
			readGitBlob(cwd, this.settings.baseRef, oldPath),
			this.readWorkingFile(spec.name),
		]);
		return {
			oldFile: { name: oldPath, contents: oldContents ?? "" },
			newFile: { name: spec.name, contents: newContents ?? "" },
		};
	}

	private async probeBlobSize(cwd: string, ref: string, path: string): Promise<number> {
		const content = await readGitBlob(cwd, ref, path);
		return content?.length ?? 0;
	}

	private async probeWorkingSize(relativePath: string): Promise<number> {
		try {
			const stat = await this.app.vault.adapter.stat(relativePath);
			return stat?.size ?? 0;
		} catch {
			return 0;
		}
	}

	private async readWorkingFile(relativePath: string): Promise<string | null> {
		try {
			return await this.app.vault.adapter.read(relativePath);
		} catch {
			return null;
		}
	}

	private getVaultPath(): string | null {
		const adapter = this.app.vault.adapter as { basePath?: string; getBasePath?: () => string };
		if (typeof adapter.getBasePath === "function") return adapter.getBasePath();
		if (typeof adapter.basePath === "string") return adapter.basePath;
		return null;
	}

	private async ensureView(): Promise<GitDiffsView> {
		const existing = this.app.workspace.getLeavesOfType(GIT_DIFFS_VIEW_TYPE)[0];
		let leaf: WorkspaceLeaf;
		if (existing) {
			leaf = existing;
		} else {
			leaf = this.app.workspace.getLeaf("tab");
			await leaf.setViewState({ type: GIT_DIFFS_VIEW_TYPE, active: true });
		}
		this.app.workspace.revealLeaf(leaf);
		return leaf.view as GitDiffsView;
	}

	private async showDiffForActiveFile(): Promise<void> {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const file = view?.file;
		if (!file) {
			new Notice("No active file");
			return;
		}
		await this.showDiffForFile(file);
	}

	async showDiffForFile(file: TFile): Promise<void> {
		const target = await this.ensureView();
		target.setDiff(this.emptyState(`Diff: ${file.path}`, "Loading…"), file.path);
		await this.refreshDiff(target, file.path);
	}

	private async showDiffForVault(): Promise<void> {
		const target = await this.ensureView();
		target.setDiff(this.emptyState("Diff: vault", "Loading…"), null);
		await this.refreshDiff(target, null);
	}
}

function hashString(s: string): string {
	let h = 0;
	for (let i = 0; i < s.length; i++) {
		h = (h * 31 + s.charCodeAt(i)) | 0;
	}
	return `${h.toString(16)}:${s.length}`;
}

