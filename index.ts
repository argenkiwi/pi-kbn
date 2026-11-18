/**
 * pi-kbn — kanban discipline for the Pi coding agent.
 *
 * - `kanban` tool: the agent splits work into atomic tasks and moves them todo → doing → done.
 * - One task at a time; after `done` the agent must stop until the user replies.
 * - edit/write are blocked unless a task is in progress (and not awaiting confirmation).
 * - Footer status shows todo/done counts and the task in progress; a widget shows the doing task.
 * - Ghost hint in the prompt box: "Proceed with next task" / "Resume current task" (Tab to accept).
 * - `/kanban [show|on|off|clear]` for the user.
 *
 * Board state is stored in the kanban tool's result `details` (plus `kanban-state` custom
 * entries for user commands) and rebuilt from the current branch, so /tree, forks and
 * resumed sessions always see the board as it was at that point in history.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	add,
	type Board,
	complete,
	confirm,
	describe,
	doingTask,
	edit,
	emptyBoard,
	hintFor,
	isBoard,
	remove,
	replay,
	start,
	type Transition,
} from "./src/board.ts";
import { boardContext, KANBAN_RULES } from "./src/prompt.ts";
import { BoardComponent, doingWidget, KANBAN_EDITOR, KanbanEditor, statusText } from "./src/ui.ts";

const TOOL = "kanban";
const STATE_ENTRY = "kanban-state";
const CONTEXT_MESSAGE = "kanban-context";
const GUARDED_TOOLS = new Set(["edit", "write"]);

const ACTIONS = ["add", "start", "done", "edit", "remove", "list"] as const;
type Action = (typeof ACTIONS)[number];

const KanbanParams = Type.Object({
	action: StringEnum(ACTIONS),
	titles: Type.Optional(Type.Array(Type.String(), { description: "Task titles to add (for add)" })),
	id: Type.Optional(
		Type.Number({ description: "Task id (for start/done/edit/remove; start defaults to the next todo task)" }),
	),
	title: Type.Optional(Type.String({ description: "New title (for edit)" })),
	note: Type.Optional(Type.String({ description: "Optional one-line completion note (for done)" })),
});

interface KanbanDetails {
	action: Action;
	message: string;
	board: Board;
}

export default function kanbanExtension(pi: ExtensionAPI): void {
	let board: Board = emptyBoard();
	/** Runtime-only: a doing task was left unfinished (abort/error/resumed session). */
	let interrupted = false;
	let ctxRef: ExtensionContext | undefined;
	let editorTui: { requestRender(force?: boolean): void } | undefined;
	let useWidgetHint = false;

	const isIdle = () => {
		try {
			return ctxRef?.isIdle() ?? true;
		} catch {
			return true;
		}
	};

	const currentHint = (): string | undefined => (isIdle() ? hintFor(board, interrupted) : undefined);

	function refreshUI(ctx: ExtensionContext): void {
		ctxRef = ctx;
		if (!ctx.hasUI) return;
		const theme = ctx.ui.theme;
		ctx.ui.setStatus("kanban", statusText(board, interrupted, theme));
		ctx.ui.setWidget("kanban", doingWidget(board, interrupted, theme));
		if (useWidgetHint) {
			const hint = currentHint();
			ctx.ui.setWidget("kanban-hint", hint ? [theme.fg("dim", `💡 ${hint}`)] : undefined, {
				placement: "belowEditor",
			});
		}
		editorTui?.requestRender();
	}

	function reconstruct(ctx: ExtensionContext): void {
		const snapshots: unknown[] = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "message") {
				const msg = entry.message;
				if (msg.role === "toolResult" && msg.toolName === TOOL) {
					const details = msg.details as KanbanDetails | undefined;
					if (details && isBoard(details.board)) snapshots.push(details.board);
				}
			} else if (entry.type === "custom" && entry.customType === STATE_ENTRY) {
				snapshots.push(entry.data);
			}
		}
		board = replay(snapshots);
		interrupted = !!doingTask(board);
	}

	function installEditor(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const previous = ctx.ui.getEditorComponent() as (Record<symbol, unknown> & object) | undefined;
		if (previous && !previous[KANBAN_EDITOR]) {
			// Another extension owns the editor: don't clobber it, show the hint as a widget instead.
			useWidgetHint = true;
			return;
		}
		useWidgetHint = false;
		const factory = Object.assign(
			(tui: ConstructorParameters<typeof KanbanEditor>[0], theme: ConstructorParameters<typeof KanbanEditor>[1], kb: ConstructorParameters<typeof KanbanEditor>[2]) => {
				editorTui = tui;
				return new KanbanEditor(tui, theme, kb, currentHint, (s) => {
					try {
						return (ctxRef ?? ctx).ui.theme.fg("dim", s);
					} catch {
						return s;
					}
				});
			},
			{ [KANBAN_EDITOR]: true },
		);
		ctx.ui.setEditorComponent(factory);
	}

	function persist(): void {
		pi.appendEntry(STATE_ENTRY, board);
	}

	// ── Session lifecycle ────────────────────────────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		reconstruct(ctx);
		installEditor(ctx);
		refreshUI(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		reconstruct(ctx);
		refreshUI(ctx);
	});

	// ── Steering ─────────────────────────────────────────────────────────────
	pi.on("input", async (event, ctx) => {
		// Any real user message is the confirmation to move on.
		if (event.source === "extension") return;
		if (board.awaitingConfirmation) {
			board = confirm(board);
			refreshUI(ctx);
		}
	});

	pi.on("before_agent_start", async (event) => {
		if (!board.enabled) return;
		const context = boardContext(board, interrupted);
		return {
			systemPrompt: `${event.systemPrompt}\n\n${KANBAN_RULES}`,
			...(context ? { message: { customType: CONTEXT_MESSAGE, content: context, display: false } } : {}),
		};
	});

	pi.on("agent_start", async (_event, ctx) => {
		interrupted = false;
		refreshUI(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		// The run ended (normally, by Esc, or by error) with a task still open.
		if (doingTask(board)) interrupted = true;
		refreshUI(ctx);
	});

	pi.on("tool_call", async (event) => {
		if (!board.enabled || !GUARDED_TOOLS.has(event.toolName)) return;
		if (board.awaitingConfirmation) {
			return {
				block: true,
				reason: "pi-kbn: waiting for user confirmation before the next task. End your turn now.",
			};
		}
		if (!doingTask(board)) {
			return {
				block: true,
				reason: "pi-kbn: no task in progress. Add tasks with `kanban add` and start one with `kanban start` (in its own step) before editing.",
			};
		}
	});

	// ── kanban tool ──────────────────────────────────────────────────────────
	pi.registerTool({
		name: TOOL,
		label: "Kanban",
		description:
			"Manage the session kanban board (todo → doing → done). Actions: add (titles[]), start (id? — defaults to next todo), done (id?, note?), edit (id, title), remove (id), list. Only one task can be in progress; after done, stop and wait for the user.",
		promptSnippet: "Manage the kanban board: add/start/done/edit/remove/list atomic tasks",
		parameters: KanbanParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const action = params.action as Action;
			let result: Transition;
			switch (action) {
				case "add":
					result = add(board, params.titles ?? (params.title ? [params.title] : []));
					break;
				case "start":
					result = start(board, params.id);
					break;
				case "done":
					result = complete(board, params.id, params.note);
					break;
				case "edit":
					result = edit(board, params.id, params.title);
					break;
				case "remove":
					result = remove(board, params.id);
					break;
				default:
					result = { board, message: "Board:" };
			}
			// Throwing marks the result as an error for the LLM; the board is unchanged.
			if (result.error) throw new Error(`${result.error}\n\nBoard:\n${describe(board)}`);

			board = result.board;
			if (action === "start") interrupted = false;
			refreshUI(ctx);

			let text = `${result.message}\n\nBoard:\n${describe(board)}`;
			if (action === "done") {
				text +=
					"\n\nSTOP now: summarise what changed in 1–3 lines and end your turn. Do not start the next task; the user will confirm.";
			} else if (action === "add" && !doingTask(board)) {
				text += "\n\nNext: start one task with `kanban start` (on its own) before editing.";
			}
			return {
				content: [{ type: "text", text }],
				details: { action, message: result.message, board } satisfies KanbanDetails,
			};
		},

		renderCall(args, theme) {
			const icons: Record<string, string> = { add: "+", start: "▶", done: "✓", edit: "✎", remove: "✗", list: "≡" };
			let text = theme.fg("toolTitle", theme.bold("kanban ")) + theme.fg("muted", `${icons[args.action] ?? ""} ${args.action}`);
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			if (args.titles?.length) text += ` ${theme.fg("dim", args.titles.map((t: string) => `"${t}"`).join(", "))}`;
			if (args.title) text += ` ${theme.fg("dim", `"${args.title}"`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as KanbanDetails | undefined;
			if (!details) {
				const first = result.content[0];
				const msg = first?.type === "text" ? first.text.split("\n")[0]! : "";
				return new Text(theme.fg("error", msg), 0, 0);
			}
			const colour = details.action === "done" ? "success" : details.action === "list" ? "muted" : "accent";
			let text = theme.fg(colour, details.message);
			if (expanded || details.action === "list" || details.action === "add") {
				text += `\n${theme.fg("dim", describe(details.board))}`;
			}
			return new Text(text, 0, 0);
		},
	});

	// ── /kanban command ──────────────────────────────────────────────────────
	const SUBCOMMANDS = [
		{ value: "show", label: "show", description: "Show the board" },
		{ value: "on", label: "on", description: "Enable kanban enforcement" },
		{ value: "off", label: "off", description: "Disable kanban enforcement" },
		{ value: "clear", label: "clear", description: "Clear all tasks" },
	];

	pi.registerCommand("kanban", {
		description: "Kanban board: show | on | off | clear",
		getArgumentCompletions: (prefix) => {
			const items = SUBCOMMANDS.filter((s) => s.value.startsWith(prefix.trim()));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const sub = args.trim().toLowerCase() || "show";
			switch (sub) {
				case "on":
				case "off":
					board = { ...board, enabled: sub === "on" };
					persist();
					ctx.ui.notify(`Kanban enforcement ${sub}.`, "info");
					break;
				case "clear":
					board = emptyBoard(board.enabled);
					interrupted = false;
					persist();
					ctx.ui.notify("Kanban board cleared.", "info");
					break;
				case "show":
					if (!ctx.hasUI) {
						ctx.ui.notify(describe(board), "info");
						break;
					}
					await ctx.ui.custom<void>((_tui, theme, _kb, done) => new BoardComponent(board, theme, () => done()), {
						overlay: true,
						overlayOptions: { anchor: "center", width: "80%" },
					});
					break;
				default:
					ctx.ui.notify(`Unknown subcommand "${sub}". Use: show | on | off | clear`, "error");
			}
			refreshUI(ctx);
		},
	});
}
