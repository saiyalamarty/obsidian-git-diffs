import { App } from "obsidian";
import type { StatusCode } from "./git";

const STATUS_CLASSES = [
	"git-diffs-status-M",
	"git-diffs-status-A",
	"git-diffs-status-D",
	"git-diffs-status-R",
	"git-diffs-status-U",
	"git-diffs-status-I",
	"git-diffs-status-descendant",
] as const;

interface FileExplorerItem {
	selfEl?: HTMLElement;
	el?: HTMLElement;
}

interface FileExplorerView {
	fileItems?: Record<string, FileExplorerItem>;
}

export class FileExplorerDecorator {
	private app: App;
	private statusMap: Map<string, StatusCode> = new Map();
	private descendants: Set<string> = new Set();

	constructor(app: App) {
		this.app = app;
	}

	setStatus(statusMap: Map<string, StatusCode>): void {
		this.statusMap = statusMap;
		this.descendants = this.computeDescendants(statusMap);
		this.apply();
	}

	clear(): void {
		this.statusMap.clear();
		this.descendants.clear();
		this.apply();
	}

	apply(): void {
		const leaves = this.app.workspace.getLeavesOfType("file-explorer");
		for (const leaf of leaves) {
			const view = leaf.view as unknown as FileExplorerView;
			const items = view?.fileItems;
			if (!items) continue;

			for (const [path, item] of Object.entries(items)) {
				const el = item.selfEl ?? item.el;
				if (!el) continue;

				for (const cls of STATUS_CLASSES) el.classList.remove(cls);
				el.removeAttribute("data-git-status");

				const code = this.statusMap.get(path);
				if (code) {
					el.classList.add(`git-diffs-status-${code}`);
					el.setAttribute("data-git-status", code);
				} else if (this.descendants.has(path)) {
					el.classList.add("git-diffs-status-descendant");
				}
			}
		}
	}

	private computeDescendants(statusMap: Map<string, StatusCode>): Set<string> {
		const set = new Set<string>();
		for (const path of statusMap.keys()) {
			const parts = path.split("/");
			for (let i = parts.length - 1; i > 0; i--) {
				set.add(parts.slice(0, i).join("/"));
			}
		}
		return set;
	}
}
