import { type Board, describe, doingTask } from "./board.ts";

/** Static rules appended to the system prompt (kept constant so prompt caching survives). */
export const KANBAN_RULES = `
## Kanban workflow (enforced by the pi-kbn extension)

You work through a simple kanban board with three columns: todo → doing → done. Use the \`kanban\` tool to manage it.

1. Before changing any file, break the user's request into small, atomic tasks and add them all at once with \`kanban add\` (\`titles\`: one short imperative title per task). Each task should be one independently verifiable change.
2. Start exactly one task with \`kanban start\`. Call it on its own, before any edit or write in the same step. Edits and writes are blocked while no task is in progress.
3. Work only on the task in progress. If you discover extra work, add it to todo with \`kanban add\`; do not widen the current task.
4. When the task is finished, call \`kanban done\` (optionally with a short \`note\`), then summarise what changed in 1–3 lines and END YOUR TURN. Do not start the next task: the user must confirm first. Starting a task, editing and writing are blocked until the user replies.
5. Use \`kanban edit\` / \`kanban remove\` to refine todo tasks, and \`kanban list\` to see the board.
6. Questions, explanations and read-only exploration need no tasks.
`.trim();

/** Per-prompt board snapshot injected as a hidden message (keeps the system prompt static). */
export function boardContext(board: Board, interrupted: boolean): string | undefined {
	const current = doingTask(board);
	if (board.tasks.length === 0) return undefined;
	const parts = [`[KANBAN BOARD]\n${describe(board)}`];
	if (current && interrupted) {
		parts.push(
			`Task #${current.id} "${current.title}" is in progress and was interrupted. Re-check its current state (files may be partially edited) and continue it. Do not start another task.`,
		);
	}
	return parts.join("\n\n");
}
