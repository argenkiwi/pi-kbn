import assert from "node:assert/strict";
import { describe as suite, test } from "node:test";
import {
	add,
	complete,
	confirm,
	counts,
	doingTask,
	edit,
	emptyBoard,
	hintFor,
	remove,
	replay,
	start,
} from "../src/board.ts";

const seeded = () => add(emptyBoard(), ["A", "B", "C"]).board;

suite("add", () => {
	test("adds a batch of todo tasks with sequential ids", () => {
		const b = seeded();
		assert.deepEqual(
			b.tasks.map((t) => [t.id, t.title, t.status]),
			[
				[1, "A", "todo"],
				[2, "B", "todo"],
				[3, "C", "todo"],
			],
		);
		assert.equal(b.nextId, 4);
	});

	test("rejects empty titles and does not mutate input", () => {
		const b = emptyBoard();
		const r = add(b, ["  ", ""]);
		assert.ok(r.error);
		assert.equal(r.board, b);
		assert.equal(b.tasks.length, 0);
	});

	test("is allowed while a task is in progress", () => {
		const b = start(seeded(), 1).board;
		const r = add(b, ["D"]);
		assert.equal(r.error, undefined);
		assert.equal(counts(r.board).todo, 3);
	});
});

suite("start", () => {
	test("defaults to the next todo task", () => {
		const r = start(seeded(), undefined);
		assert.equal(doingTask(r.board)?.id, 1);
	});

	test("only one task can be doing", () => {
		const b = start(seeded(), 1).board;
		const r = start(b, 2);
		assert.match(r.error ?? "", /in progress/);
		assert.equal(counts(r.board).doing, 1);
	});

	test("cannot start a done or unknown task", () => {
		let b = start(seeded(), 1).board;
		b = confirm(complete(b, 1).board);
		assert.ok(start(b, 1).error);
		assert.ok(start(b, 99).error);
	});

	test("is blocked until the user confirms after a completion", () => {
		let b = start(seeded(), 1).board;
		b = complete(b, undefined).board;
		assert.equal(b.awaitingConfirmation, true);
		assert.match(start(b, 2).error ?? "", /confirmation/);
		b = confirm(b);
		assert.equal(start(b, 2).error, undefined);
	});
});

suite("complete", () => {
	test("only the doing task can be completed", () => {
		const b = start(seeded(), 2).board;
		assert.ok(complete(b, 1).error);
		const r = complete(b, 2, " shipped ");
		assert.equal(r.error, undefined);
		assert.equal(r.board.tasks[1]!.status, "done");
		assert.equal(r.board.tasks[1]!.note, "shipped");
	});

	test("errors when nothing is in progress", () => {
		assert.ok(complete(seeded(), undefined).error);
	});
});

suite("edit/remove", () => {
	test("work on todo tasks only", () => {
		const b = start(seeded(), 1).board;
		assert.ok(edit(b, 1, "X").error);
		assert.ok(remove(b, 1).error);
		assert.equal(edit(b, 2, "B2").board.tasks[1]!.title, "B2");
		assert.deepEqual(
			remove(b, 3).board.tasks.map((t) => t.id),
			[1, 2],
		);
	});
});

suite("hintFor", () => {
	test("proceed when todo remains and nothing is doing", () => {
		assert.equal(hintFor(seeded(), false), "Proceed with next task");
		assert.equal(hintFor(emptyBoard(), false), undefined);
	});

	test("resume only when the doing task was interrupted", () => {
		const b = start(seeded(), 1).board;
		assert.equal(hintFor(b, false), undefined);
		assert.equal(hintFor(b, true), "Resume current task");
	});

	test("no hint when all tasks are done or enforcement is off", () => {
		let b = add(emptyBoard(), ["A"]).board;
		b = complete(start(b, 1).board, 1).board;
		assert.equal(hintFor(b, false), undefined);
		assert.equal(hintFor({ ...seeded(), enabled: false }, false), undefined);
	});
});

suite("replay", () => {
	test("last snapshot wins and non-boards are ignored", () => {
		const s1 = seeded();
		const s2 = start(s1, 1).board;
		const b = replay([s1, { nope: true }, s2, undefined]);
		assert.equal(doingTask(b)?.id, 1);
		assert.notEqual(b, s2); // cloned
	});

	test("empty history gives an empty enabled board", () => {
		assert.deepEqual(replay([]), emptyBoard());
	});
});
