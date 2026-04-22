import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export interface GitDiffOptions {
	cwd: string;
	baseRef: string;
	relativePath?: string;
	includeUntracked: boolean;
}

export interface GitDiffResult {
	patch: string;
	hasChanges: boolean;
}

export async function getGitDiff(options: GitDiffOptions): Promise<GitDiffResult> {
	const { cwd, baseRef, relativePath, includeUntracked } = options;

	const pathspec = relativePath ? ` -- ${shellQuote(relativePath)}` : "";
	const command = `git diff ${shellQuote(baseRef)}${pathspec}`;

	const { stdout: tracked } = await execAsync(command, { cwd, maxBuffer: 50 * 1024 * 1024 });

	let untracked = "";
	if (includeUntracked && !relativePath) {
		untracked = await getUntrackedDiff(cwd);
	} else if (includeUntracked && relativePath) {
		const isTracked = await isPathTracked(cwd, relativePath);
		if (!isTracked) {
			untracked = await getSingleUntrackedDiff(cwd, relativePath);
		}
	}

	const patch = [tracked, untracked].filter(Boolean).join("\n");
	return { patch, hasChanges: patch.trim().length > 0 };
}

async function isPathTracked(cwd: string, relativePath: string): Promise<boolean> {
	try {
		await execAsync(`git ls-files --error-unmatch ${shellQuote(relativePath)}`, { cwd });
		return true;
	} catch {
		return false;
	}
}

async function getUntrackedDiff(cwd: string): Promise<string> {
	const { stdout } = await execAsync("git ls-files --others --exclude-standard", { cwd });
	const files = stdout.split("\n").filter(Boolean);
	const patches = await Promise.all(files.map((f) => getSingleUntrackedDiff(cwd, f)));
	return patches.filter(Boolean).join("\n");
}

async function getSingleUntrackedDiff(cwd: string, relativePath: string): Promise<string> {
	try {
		const { stdout } = await execAsync(
			`git diff --no-index -- /dev/null ${shellQuote(relativePath)}`,
			{ cwd, maxBuffer: 50 * 1024 * 1024 },
		);
		return stdout;
	} catch (err: unknown) {
		const e = err as { code?: number; stdout?: string };
		if (e.code === 1 && e.stdout) return e.stdout;
		return "";
	}
}

export async function isGitRepo(cwd: string): Promise<boolean> {
	try {
		await execAsync("git rev-parse --is-inside-work-tree", { cwd });
		return true;
	} catch {
		return false;
	}
}

export type StatusCode = "M" | "A" | "D" | "R" | "U" | "I";

const STATUS_BY_CHAR: Record<string, StatusCode | undefined> = {
	M: "M",
	A: "A",
	D: "D",
	R: "R",
	C: "R",
	T: "M",
};

function classifyStatus(x: string, y: string): StatusCode {
	if (x === "?" && y === "?") return "U";
	if (x === "!" && y === "!") return "I";
	if (x === "R" || y === "R" || x === "C" || y === "C") return "R";
	return STATUS_BY_CHAR[y] ?? STATUS_BY_CHAR[x] ?? "M";
}

export async function getGitStatus(cwd: string): Promise<Map<string, StatusCode>> {
	const result = new Map<string, StatusCode>();
	try {
		const { stdout } = await execAsync(
			"git status --porcelain=v1 -z --untracked-files=all",
			{ cwd, maxBuffer: 20 * 1024 * 1024 },
		);
		const tokens = stdout.split("\0");
		let i = 0;
		while (i < tokens.length) {
			const tok = tokens[i];
			if (!tok || tok.length < 3) {
				i++;
				continue;
			}
			const x = tok.charAt(0);
			const y = tok.charAt(1);
			const path = tok.slice(3);
			const code = classifyStatus(x, y);
			result.set(path, code);
			// Rename/copy entries are followed by the origPath as the next token.
			if (x === "R" || x === "C" || y === "R" || y === "C") i++;
			i++;
		}
	} catch (err) {
		console.error("[git-diffs] git status failed", err);
	}
	return result;
}

export async function readGitBlob(cwd: string, ref: string, path: string): Promise<string | null> {
	try {
		const { stdout } = await execAsync(
			`git show ${shellQuote(ref)}:${shellQuote(path)}`,
			{ cwd, maxBuffer: 50 * 1024 * 1024, encoding: "utf8" },
		);
		return stdout;
	} catch {
		// File didn't exist at that ref (new file, or outside the tree)
		return null;
	}
}

function shellQuote(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}
