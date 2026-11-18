import { CustomEditor, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type EditorTheme,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { type Board, counts, doingTask, type Status, type Task } from "./board.ts";

/** Footer status line, e.g. `☐ 3 todo  ▶ #4 Add CSV parser  ✓ 5 done`. */
export function statusText(board: Board, interrupted: boolean, theme: Theme): string | undefined {
	if (!board.enabled) return theme.fg("dim", "kanban off");
	if (board.tasks.length === 0) return undefined;
	const c = counts(board);
	const parts = [theme.fg("muted", `☐ ${c.todo} todo`)];
	const current = doingTask(board);
	if (current) {
		parts.push(
			interrupted
				? theme.fg("warning", `⚠ #${current.id} ${current.title} (interrupted)`)
				: theme.fg("accent", `▶ #${current.id} ${current.title}`),
		);
	} else if (board.awaitingConfirmation) {
		parts.push(theme.fg("warning", "⏸ awaiting confirmation"));
	}
	parts.push(theme.fg("success", `✓ ${c.done} done`));
	return parts.join("  ");
}

/** One-line widget above the editor for the task in progress; undefined hides it. */
export function doingWidget(board: Board, interrupted: boolean, theme: Theme): string[] | undefined {
	const current = board.enabled ? doingTask(board) : undefined;
	if (!current) return undefined;
	const label = interrupted ? theme.fg("warning", "⚠ Interrupted:") : theme.fg("accent", "▶ Doing:");
	return [`${label} ${theme.fg("accent", `#${current.id}`)} ${theme.fg("text", current.title)}`];
}

/** Marker so we can recognise our own editor factory in getEditorComponent(). */
export const KANBAN_EDITOR = Symbol.for("pi-kbn.editor");

/**
 * Editor that shows a dim ghost hint when it is empty (Pi has no placeholder API).
 * Tab on an empty editor fills in the hint text so the user can edit it or press Enter.
 */
export class KanbanEditor extends CustomEditor {
	private getHint: () => string | undefined;
	private dim: (text: string) => string;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		getHint: () => string | undefined,
		dim: (text: string) => string,
	) {
		super(tui, theme, keybindings);
		this.getHint = getHint;
		this.dim = dim;
	}

	private activeHint(): string | undefined {
		if (this.getText() !== "") return undefined;
		try {
			return this.getHint();
		} catch {
			return undefined; // stale context after session replacement
		}
	}

	override handleInput(data: string): void {
		const hint = this.activeHint();
		if (hint && matchesKey(data, "tab")) {
			this.setText(hint);
			return;
		}
		super.handleInput(data);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		const hint = this.activeHint();
		// lines[0] is the top border, lines[1] the (empty) first content line holding the cursor.
		if (!hint || lines.length < 3) return lines;
		const base = lines[1]!.replace(/ +$/, "");
		const ghost = this.dim(` ${hint}  (Tab)`);
		const combined = truncateToWidth(base + ghost, width, "");
		lines[1] = combined + " ".repeat(Math.max(0, width - visibleWidth(combined)));
		return lines;
	}
}

/** Three-column board overlay for /kanban. */
export class BoardComponent implements Component {
	private board: Board;
	private theme: Theme;
	private onClose: () => void;

	constructor(board: Board, theme: Theme, onClose: () => void) {
		this.board = board;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "enter") || data === "q") {
			this.onClose();
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		const th = this.theme;
		const inner = Math.max(30, width);
		const gap = 2;
		const colWidth = Math.max(8, Math.floor((inner - 2 - gap * 2) / 3));
		const columns: { status: Status; title: string; color: "muted" | "accent" | "success" }[] = [
			{ status: "todo", title: "Todo", color: "muted" },
			{ status: "doing", title: "Doing", color: "accent" },
			{ status: "done", title: "Done", color: "success" },
		];
		const cell = (text: string) => {
			const t = truncateToWidth(text, colWidth);
			return t + " ".repeat(Math.max(0, colWidth - visibleWidth(t)));
		};
		const item = (task: Task) => {
			const id = th.fg("accent", `#${task.id}`);
			if (task.status === "done") return `${th.fg("success", "✓")} ${id} ${th.fg("dim", task.title)}`;
			if (task.status === "doing") return `${th.fg("accent", "▶")} ${id} ${th.fg("text", task.title)}`;
			return `${th.fg("dim", "○")} ${id} ${th.fg("text", task.title)}`;
		};

		const lists = columns.map((c) => this.board.tasks.filter((t) => t.status === c.status));
		const rows = Math.max(1, ...lists.map((l) => l.length));
		const sep = " ".repeat(gap);
		const lines: string[] = [];
		const title = th.fg("accent", " Kanban ");
		lines.push(truncateToWidth(th.fg("borderMuted", "───") + title + th.fg("borderMuted", "─".repeat(inner)), width));
		lines.push("");
		lines.push(
			` ${columns.map((c, i) => cell(th.fg(c.color, th.bold(`${c.title} (${lists[i]!.length})`)))).join(sep)}`,
		);
		lines.push(` ${columns.map(() => th.fg("borderMuted", "─".repeat(colWidth))).join(sep)}`);
		for (let r = 0; r < rows; r++) {
			lines.push(
				` ${lists.map((l) => cell(l[r] ? item(l[r]!) : r === 0 && l.length === 0 ? th.fg("dim", "—") : "")).join(sep)}`,
			);
		}
		lines.push("");
		if (!this.board.enabled) lines.push(` ${th.fg("warning", "Enforcement is off (/kanban on to enable)")}`);
		else if (this.board.awaitingConfirmation) lines.push(` ${th.fg("warning", "⏸ Awaiting your confirmation")}`);
		lines.push(` ${th.fg("dim", "Esc to close")}`);
		lines.push("");
		return lines.map((l) => truncateToWidth(l, width));
	}
}
