/**
 * Wiring test: drives the real extension's hooks and kanban tool through a fake `pi`
 * so the enforcement flow is verified without an LLM.
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import kanbanExtension from "../index.ts";

type Handler = (event: any, ctx: any) => any;

function harness() {
	const handlers = new Map<string, Handler[]>();
	let tool: any;
	const entries: any[] = [];
	const status: Record<string, string | undefined> = {};
	let idle = true;

	const pi: any = {
		on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
		registerTool: (t: any) => (tool = t),
		registerCommand: () => {},
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
	};
	const ctx: any = {
		hasUI: false,
		ui: { theme: { fg: (_c: string, s: string) => s }, setStatus: (k: string, v?: string) => (status[k] = v) },
		sessionManager: { getBranch: () => entries },
		isIdle: () => idle,
	};
	kanbanExtension(pi);

	const emit = async (name: string, event: any = {}) => {
		let last: any;
		for (const h of handlers.get(name) ?? []) last = (await h({ type: name, ...event }, ctx)) ?? last;
		return last;
	};
	const call = async (params: any) => {
		try {
			const r = await tool.execute("id", params, undefined, undefined, ctx);
			entries.push({ type: "message", message: { role: "toolResult", toolName: "kanban", details: r.details } });
			return { ok: true, text: r.content[0].text as string };
		} catch (e) {
			return { ok: false, text: (e as Error).message };
		}
	};
	const userSays = async () => {
		await emit("input", { text: "go", source: "interactive" });
		return emit("before_agent_start", { systemPrompt: "BASE" });
	};
	return {
		emit,
		call,
		userSays,
		entries,
		setIdle: (v: boolean) => (idle = v),
		guard: (toolName: string) => emit("tool_call", { toolName, toolCallId: "t", input: {} }),
	};
}

let h: ReturnType<typeof harness>;
beforeEach(async () => {
	h = harness();
	await h.emit("session_start", { reason: "startup" });
});

test("system prompt gets the kanban rules", async () => {
	const r = await h.userSays();
	assert.match(r.systemPrompt, /^BASE\n\n## Kanban workflow/);
});

test("edit/write blocked until a task is in progress; read is never blocked", async () => {
	assert.equal((await h.guard("edit"))?.block, true);
	assert.equal(await h.guard("read"), undefined);
	await h.call({ action: "add", titles: ["A", "B"] });
	assert.equal((await h.guard("write"))?.block, true);
	await h.call({ action: "start" });
	assert.equal(await h.guard("edit"), undefined);
});

test("after done: stop instruction, gate until the user replies, then next task allowed", async () => {
	await h.call({ action: "add", titles: ["A", "B"] });
	await h.call({ action: "start", id: 1 });
	const done = await h.call({ action: "done" });
	assert.match(done.text, /STOP now/);

	const blocked = await h.call({ action: "start", id: 2 });
	assert.equal(blocked.ok, false);
	assert.match(blocked.text, /confirmation/);
	assert.match((await h.guard("edit"))?.reason ?? "", /confirmation/);

	const ctx = await h.userSays();
	assert.match(ctx.message.content, /\[ \] #2 B/);
	assert.doesNotMatch(ctx.message.content, /awaiting/);
	assert.equal((await h.call({ action: "start", id: 2 })).ok, true);
});

test("interrupted run → resume hint context, cleared once the agent restarts", async () => {
	await h.call({ action: "add", titles: ["A"] });
	await h.call({ action: "start" });
	await h.emit("agent_end", { messages: [] }); // e.g. Esc mid-task
	const r = await h.userSays();
	assert.match(r.message.content, /was interrupted/);
	await h.emit("agent_start");
	const again = await h.emit("before_agent_start", { systemPrompt: "BASE" });
	assert.doesNotMatch(again.message.content, /interrupted/);
});

test("resumed session rebuilds the board from history and flags the doing task as interrupted", async () => {
	await h.call({ action: "add", titles: ["A", "B"] });
	await h.call({ action: "start" });
	await h.emit("session_start", { reason: "resume" }); // same branch entries, fresh state rebuild
	const r = await h.emit("before_agent_start", { systemPrompt: "BASE" });
	assert.match(r.message.content, /\[>\] #1 A/);
	assert.match(r.message.content, /was interrupted/);
});

test("/kanban off state (custom entry) disables enforcement on replay", async () => {
	h.entries.push({ type: "custom", customType: "kanban-state", data: { tasks: [], nextId: 1, awaitingConfirmation: false, enabled: false } });
	await h.emit("session_start", { reason: "resume" });
	assert.equal(await h.guard("edit"), undefined);
	assert.equal(await h.emit("before_agent_start", { systemPrompt: "BASE" }), undefined);
});
