/**
 * Pure kanban board model. No pi imports so it can be unit-tested with `node --test`.
 *
 * Invariants:
 * - at most one task is "doing"
 * - a task can only be started from "todo", and only when the user has confirmed
 *   since the last completed task (awaitingConfirmation === false)
 * - only the "doing" task can be completed
 * - only "todo" tasks can be edited or removed
 */

export type Status = "todo" | "doing" | "done";

export interface Task {
	id: number;
	title: string;
	status: Status;
	note?: string;
}

export interface Board {
	tasks: Task[];
	nextId: number;
	/** Set when a task is completed; cleared only by a user message (confirm). */
	awaitingConfirmation: boolean;
	/** Enforcement on/off (toggled by the user with /kanban on|off). */
	enabled: boolean;
}

export interface Transition {
	board: Board;
	/** Human/LLM-readable outcome. */
	message: string;
	/** Set when the transition was rejected; `board` is then the unchanged input. */
	error?: string;
}

export function emptyBoard(enabled = true): Board {
	return { tasks: [], nextId: 1, awaitingConfirmation: false, enabled };
}

export function cloneBoard(board: Board): Board {
	return { ...board, tasks: board.tasks.map((t) => ({ ...t })) };
}

export function isBoard(value: unknown): value is Board {
	const b = value as Board | undefined;
	return !!b && Array.isArray(b.tasks) && typeof b.nextId === "number";
}

export function doingTask(board: Board): Task | undefined {
	return board.tasks.find((t) => t.status === "doing");
}

export function counts(board: Board): Record<Status, number> {
	const c: Record<Status, number> = { todo: 0, doing: 0, done: 0 };
	for (const t of board.tasks) c[t.status]++;
	return c;
}

export function nextTodo(board: Board): Task | undefined {
	return board.tasks.find((t) => t.status === "todo");
}

function reject(board: Board, error: string): Transition {
	return { board, message: error, error };
}

function find(board: Board, id: number | undefined): Task | undefined {
	return id === undefined ? undefined : board.tasks.find((t) => t.id === id);
}

export function add(board: Board, titles: string[]): Transition {
	const clean = titles.map((t) => t.trim()).filter((t) => t.length > 0);
	if (clean.length === 0) return reject(board, "Provide at least one non-empty task title in `titles`.");
	const next = cloneBoard(board);
	const added: Task[] = [];
	for (const title of clean) {
		const task: Task = { id: next.nextId++, title, status: "todo" };
		next.tasks.push(task);
		added.push(task);
	}
	return { board: next, message: `Added ${added.map((t) => `#${t.id} ${t.title}`).join(", ")}.` };
}

export function start(board: Board, id: number | undefined): Transition {
	if (board.awaitingConfirmation) {
		return reject(
			board,
			"Waiting for user confirmation before the next task. End your turn now and let the user confirm.",
		);
	}
	const current = doingTask(board);
	if (current) {
		return reject(
			board,
			`Task #${current.id} "${current.title}" is in progress; finish it with \`done\` before starting another.`,
		);
	}
	const task = id === undefined ? nextTodo(board) : find(board, id);
	if (!task) return reject(board, id === undefined ? "There are no todo tasks to start." : `Task #${id} not found.`);
	if (task.status !== "todo") return reject(board, `Task #${task.id} is ${task.status}; only todo tasks can be started.`);
	const next = cloneBoard(board);
	find(next, task.id)!.status = "doing";
	return { board: next, message: `Started #${task.id} ${task.title}.` };
}

export function complete(board: Board, id: number | undefined, note?: string): Transition {
	const current = doingTask(board);
	if (!current) return reject(board, "No task is in progress; nothing to complete.");
	if (id !== undefined && id !== current.id) {
		return reject(board, `Task #${id} is not in progress; the current task is #${current.id} "${current.title}".`);
	}
	const next = cloneBoard(board);
	const task = find(next, current.id)!;
	task.status = "done";
	if (note?.trim()) task.note = note.trim();
	next.awaitingConfirmation = true;
	return { board: next, message: `Completed #${task.id} ${task.title}.` };
}

export function edit(board: Board, id: number | undefined, title: string | undefined): Transition {
	const task = find(board, id);
	if (!task) return reject(board, `Task #${id} not found.`);
	if (task.status !== "todo") return reject(board, `Task #${task.id} is ${task.status}; only todo tasks can be edited.`);
	if (!title?.trim()) return reject(board, "Provide a non-empty `title`.");
	const next = cloneBoard(board);
	find(next, task.id)!.title = title.trim();
	return { board: next, message: `Renamed #${task.id} to ${title.trim()}.` };
}

export function remove(board: Board, id: number | undefined): Transition {
	const task = find(board, id);
	if (!task) return reject(board, `Task #${id} not found.`);
	if (task.status !== "todo") return reject(board, `Task #${task.id} is ${task.status}; only todo tasks can be removed.`);
	const next = cloneBoard(board);
	next.tasks = next.tasks.filter((t) => t.id !== task.id);
	return { board: next, message: `Removed #${task.id} ${task.title}.` };
}

/** The user has spoken: the agent may start the next task. */
export function confirm(board: Board): Board {
	if (!board.awaitingConfirmation) return board;
	return { ...cloneBoard(board), awaitingConfirmation: false };
}

/** Compact text rendering of the board for the LLM. */
export function describe(board: Board): string {
	if (board.tasks.length === 0) return "Board is empty.";
	const mark: Record<Status, string> = { todo: "[ ]", doing: "[>]", done: "[x]" };
	const lines = board.tasks.map((t) => `${mark[t.status]} #${t.id} ${t.title}`);
	if (board.awaitingConfirmation) lines.push("(awaiting user confirmation before the next task)");
	return lines.join("\n");
}

export type Hint = "Resume current task" | "Proceed with next task";

/**
 * Which ghost hint the prompt box should show while the agent is idle.
 * `interrupted` is runtime-only: true when a doing task was left unfinished
 * (Esc/abort/error, or the session was resumed with a task in progress).
 */
export function hintFor(board: Board, interrupted: boolean): Hint | undefined {
	if (!board.enabled) return undefined;
	if (doingTask(board)) return interrupted ? "Resume current task" : undefined;
	if (nextTodo(board)) return "Proceed with next task";
	return undefined;
}

/**
 * Rebuild the board from session entries, oldest first. Each entry may carry
 * a full board snapshot (kanban tool result details or a kanban-state custom entry);
 * the last snapshot wins.
 */
export function replay(snapshots: Iterable<unknown>, enabledDefault = true): Board {
	let board = emptyBoard(enabledDefault);
	for (const snap of snapshots) {
		if (isBoard(snap)) board = cloneBoard({ ...emptyBoard(enabledDefault), ...snap });
	}
	return board;
}
