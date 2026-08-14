import { mutation, query } from "./_generated/server.js";
import { components } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import { SearchIndex } from "convex-improved-search";
import { v } from "convex/values";

/**
 * One SearchIndex per logical collection. `filterFields` is typing-only:
 * misspelled filter names in set/search become compile errors.
 */
export const notesSearch = new SearchIndex(components.improvedSearch, {
	name: "notes",
	filterFields: ["category"],
});

/**
 * One mapper binds the index to the table; every sync path derives from it.
 * After any write, `notesIndexer.sync(ctx, id)` reads the row and upserts or
 * removes the entry — hard deletes included.
 */
export const notesIndexer = notesSearch.tableIndexer<Doc<"notes">>({
	table: "notes",
	map: (_ctx, note) => ({
		text: note.text,
		sortKey: note.createdAt,
		filters: { category: note.category },
	}),
});

export const addNote = mutation({
	args: {
		text: v.string(),
		category: v.union(v.literal("work"), v.literal("personal")),
	},
	handler: async (ctx, args) => {
		const noteId = await ctx.db.insert("notes", { ...args, createdAt: Date.now() });
		// Same transaction as the insert — the index can never drift.
		await notesIndexer.sync(ctx, noteId);
		return noteId;
	},
});

export const updateNote = mutation({
	args: { noteId: v.id("notes"), text: v.string() },
	handler: async (ctx, args) => {
		await ctx.db.patch("notes", args.noteId, { text: args.text });
		await notesIndexer.sync(ctx, args.noteId);
	},
});

export const deleteNote = mutation({
	args: { noteId: v.id("notes") },
	handler: async (ctx, args) => {
		await ctx.db.delete("notes", args.noteId);
		await notesIndexer.sync(ctx, args.noteId);
	},
});

/**
 * Exact substring search — CJK, emoji, whatever. Reactive like any Convex
 * query. `searchDocs` hydrates hits from the table in one call. A non-null
 * cursor with a short page means "budget spent, keep paging"; only isDone
 * means exhausted.
 */
export const searchNotes = query({
	args: {
		query: v.string(),
		category: v.optional(v.union(v.literal("work"), v.literal("personal"))),
		cursor: v.optional(v.union(v.string(), v.null())),
	},
	handler: async (ctx, args) => {
		const result = await notesSearch.searchDocs<Doc<"notes">>(ctx, {
			table: "notes",
			query: args.query,
			filters: args.category === undefined ? undefined : { category: args.category },
			cursor: args.cursor,
			limit: 20,
		});
		return {
			page: result.page.map(({ doc }) => ({
				_id: doc._id,
				text: doc.text,
				category: doc.category,
			})),
			cursor: result.cursor,
			isDone: result.isDone,
		};
	},
});

export const listNotes = query({
	args: {},
	handler: async (ctx) => {
		const notes = await ctx.db.query("notes").order("desc").take(50);
		return notes.map((note) => ({ _id: note._id, text: note.text, category: note.category }));
	},
});
