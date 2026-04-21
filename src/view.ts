import { ItemView, ViewStateResult, WorkspaceLeaf, setIcon, setTooltip } from "obsidian";
import GitDiffsPlugin, { GIT_DIFFS_REFRESH_EVENT } from "./main";
import { DiffRenderHandle, DiffStyle, FileRenderSpec, Overflow, renderDiff } from "./render";

export const GIT_DIFFS_VIEW_TYPE = "git-diffs-view";

export interface DiffViewState {
	title: string;
	message: string | null;
	files: FileRenderSpec[];
	cacheKey: string;
	diffStyle: DiffStyle;
	overflow: Overflow;
}

interface PersistedState {
	filePath: string | null;
	diffStyle?: DiffStyle;
	overflow?: Overflow;
}

export class GitDiffsView extends ItemView {
	private plugin: GitDiffsPlugin;
	private currentState: DiffViewState = {
		title: "Git Diffs",
		message: null,
		files: [],
		cacheKey: "",
		diffStyle: "unified",
		overflow: "scroll",
	};
	private persistedFilePath: string | null = null;
	private activeRender: DiffRenderHandle | null = null;
	private renderedCacheKey: string | null = null;
	private cachedBody: HTMLElement | null = null;
	private layoutActionEl: HTMLElement | null = null;
	private overflowActionEl: HTMLElement | null = null;
	private collapseAllActionEl: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: GitDiffsPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.currentState.diffStyle = plugin.settings.diffStyle;
		this.currentState.overflow = plugin.settings.overflow;
	}

	getViewType(): string {
		return GIT_DIFFS_VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.currentState.title || "Git Diffs";
	}

	getIcon(): string {
		return "git-compare";
	}

	async onOpen(): Promise<void> {
		this.registerEvent(
			this.app.workspace.on("css-change", () => {
				if (!this.activeRender) return;
				const next = document.body.classList.contains("theme-dark") ? "dark" : "light";
				this.activeRender.setThemeType(next);
			}),
		);
		this.registerEvent(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(this.app.workspace as any).on(GIT_DIFFS_REFRESH_EVENT, (paths: string[]) => {
				this.handleAutoRefresh(paths);
			}),
		);
		this.addLayoutAction();
		this.addOverflowAction();
		this.addCollapseAllAction();
		this.attachOrRedraw();
	}

	private addCollapseAllAction(): void {
		this.collapseAllActionEl = this.addAction(
			"chevrons-down-up",
			"Collapse all files",
			() => {
				if (!this.activeRender) return;
				const collapse = this.activeRender.anyExpanded();
				this.activeRender.setAllCollapsed(collapse);
				this.updateCollapseAllAction();
			},
		);
	}

	private updateCollapseAllAction(): void {
		if (!this.collapseAllActionEl) return;
		const anyExpanded = this.activeRender?.anyExpanded() ?? true;
		setIcon(this.collapseAllActionEl, anyExpanded ? "chevrons-down-up" : "chevrons-up-down");
		setTooltip(
			this.collapseAllActionEl,
			anyExpanded ? "Collapse all files" : "Expand all files",
		);
	}

	private addLayoutAction(): void {
		this.layoutActionEl = this.addAction(this.layoutIcon(), this.layoutTooltip(), () => {
			const next = this.currentState.diffStyle === "unified" ? "split" : "unified";
			this.setDiffStyle(next);
		});
	}

	private layoutIcon(): string {
		return this.currentState.diffStyle === "unified" ? "columns-2" : "rows-2";
	}

	private layoutTooltip(): string {
		return this.currentState.diffStyle === "unified"
			? "Switch to split view"
			: "Switch to unified view";
	}

	private updateLayoutAction(): void {
		if (!this.layoutActionEl) return;
		setIcon(this.layoutActionEl, this.layoutIcon());
		setTooltip(this.layoutActionEl, this.layoutTooltip());
	}

	private addOverflowAction(): void {
		this.overflowActionEl = this.addAction(this.overflowIcon(), this.overflowTooltip(), () => {
			const next = this.currentState.overflow === "scroll" ? "wrap" : "scroll";
			this.setOverflow(next);
		});
	}

	private overflowIcon(): string {
		return this.currentState.overflow === "scroll" ? "wrap-text" : "move-horizontal";
	}

	private overflowTooltip(): string {
		return this.currentState.overflow === "scroll" ? "Wrap long lines" : "Scroll long lines";
	}

	private updateOverflowAction(): void {
		if (!this.overflowActionEl) return;
		setIcon(this.overflowActionEl, this.overflowIcon());
		setTooltip(this.overflowActionEl, this.overflowTooltip());
	}

	getPersistedFilePath(): string | null {
		return this.persistedFilePath;
	}

	getCacheKey(): string {
		return this.currentState.cacheKey;
	}

	getDiffStyle(): DiffStyle {
		return this.currentState.diffStyle;
	}

	getOverflow(): Overflow {
		return this.currentState.overflow;
	}

	private handleAutoRefresh(paths: string[]): void {
		if (this.persistedFilePath === null) {
			void this.plugin.refreshDiff(this, null);
			return;
		}
		if (paths.includes(this.persistedFilePath)) {
			void this.plugin.refreshDiff(this, this.persistedFilePath);
		}
	}

	async onClose(): Promise<void> {
		if (this.cachedBody?.parentElement) this.cachedBody.remove();
	}

	getState(): Record<string, unknown> {
		return {
			...super.getState(),
			filePath: this.persistedFilePath,
			diffStyle: this.currentState.diffStyle,
			overflow: this.currentState.overflow,
		};
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		if (state && typeof state === "object") {
			const s = state as PersistedState;
			if (s.diffStyle === "unified" || s.diffStyle === "split") {
				this.currentState.diffStyle = s.diffStyle;
				this.updateLayoutAction();
			}
			if (s.overflow === "scroll" || s.overflow === "wrap") {
				this.currentState.overflow = s.overflow;
				this.updateOverflowAction();
			}
			if ("filePath" in s) {
				const fp = s.filePath ?? null;
				if (fp !== this.persistedFilePath || !this.currentState.cacheKey) {
					this.persistedFilePath = fp;
					void this.plugin.refreshDiff(this, fp);
				}
			}
		}
		await super.setState(state, result);
	}

	setDiff(state: DiffViewState, filePath: string | null): void {
		const titleChanged = state.title !== this.currentState.title;
		const cacheChanged = state.cacheKey !== this.currentState.cacheKey;
		this.currentState = state;
		this.persistedFilePath = filePath;
		if (cacheChanged) this.redraw();
		if (titleChanged) this.app.workspace.trigger("layout-change");
		this.app.workspace.requestSaveLayout();
	}

	private setDiffStyle(style: DiffStyle): void {
		if (this.currentState.diffStyle === style) return;
		this.currentState.diffStyle = style;
		this.activeRender?.setDiffStyle(style);
		this.updateLayoutAction();
		this.app.workspace.requestSaveLayout();
	}

	private setOverflow(overflow: Overflow): void {
		if (this.currentState.overflow === overflow) return;
		this.currentState.overflow = overflow;
		this.activeRender?.setOverflow(overflow);
		this.updateOverflowAction();
		this.app.workspace.requestSaveLayout();
	}

	private attachOrRedraw(): void {
		const { contentEl } = this;
		contentEl.addClass("git-diffs-view");

		if (
			this.cachedBody &&
			this.renderedCacheKey === this.currentState.cacheKey &&
			this.activeRender
		) {
			contentEl.empty();
			contentEl.appendChild(this.cachedBody);
			return;
		}
		this.redraw();
	}

	private disposeActiveRender(): void {
		if (this.activeRender) {
			this.activeRender.cleanup();
			this.activeRender = null;
		}
		this.cachedBody = null;
		this.renderedCacheKey = null;
	}

	private redraw(): void {
		this.disposeActiveRender();

		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("git-diffs-view");

		const body = contentEl.createEl("div", { cls: "git-diffs-body" });
		this.cachedBody = body;

		if (this.currentState.message) {
			body.createEl("p", { text: this.currentState.message, cls: "git-diffs-empty" });
			this.renderedCacheKey = this.currentState.cacheKey;
			return;
		}

		const content = body.createEl("div", { cls: "git-diffs-content" });
		const key = this.currentState.cacheKey;
		const files = this.currentState.files;

		void renderDiff(content, files, {
			diffStyle: this.currentState.diffStyle,
			overflow: this.currentState.overflow,
			loadLargeFile: (spec) => this.plugin.loadLargeFile(spec),
			onFileClick: (path) => {
				void this.app.workspace.openLinkText(path, "", false);
			},
		})
			.then((handle) => {
				this.activeRender = handle;
				this.renderedCacheKey = key;
				this.updateCollapseAllAction();
			})
			.catch((err) => {
				body.empty();
				body.createEl("pre", {
					text: `Render error: ${err instanceof Error ? err.message : String(err)}`,
					cls: "git-diffs-empty",
				});
			});
	}
}
