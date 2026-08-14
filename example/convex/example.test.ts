import { describe, expect, test } from "vitest";
import { initConvexTest } from "./setup.test";
import { api } from "./_generated/api";

describe("example app", () => {
	test("insert, search (CJK substring), filter, update, delete", async () => {
		const t = initConvexTest();
		const a = await t.mutation(api.example.addNote, {
			text: "回程過磅費，司機墊付停車場費",
			category: "work",
		});
		await t.mutation(api.example.addNote, {
			text: "週末去停車場對面的市場",
			category: "personal",
		});

		const all = await t.query(api.example.searchNotes, { query: "停車場" });
		expect(all.page).toHaveLength(2);
		expect(all.isDone).toBe(true);

		const workOnly = await t.query(api.example.searchNotes, {
			query: "停車場",
			category: "work",
		});
		expect(workOnly.page.map((note) => note._id)).toEqual([a]);

		await t.mutation(api.example.updateNote, { noteId: a, text: "改成過路費" });
		const afterUpdate = await t.query(api.example.searchNotes, { query: "停車場" });
		expect(afterUpdate.page).toHaveLength(1);
		const newText = await t.query(api.example.searchNotes, { query: "過路" });
		expect(newText.page.map((note) => note._id)).toEqual([a]);

		await t.mutation(api.example.deleteNote, { noteId: a });
		expect((await t.query(api.example.searchNotes, { query: "過路" })).page).toEqual([]);
	});
});
