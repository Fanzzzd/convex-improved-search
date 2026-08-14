import { mutation, query } from "./_generated/server.js";
import { components } from "./_generated/api.js";
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

export const addNote = mutation({
	args: {
		text: v.string(),
		category: v.union(v.literal("work"), v.literal("personal")),
	},
	handler: async (ctx, args) => {
		const createdAt = Date.now();
		const noteId = await ctx.db.insert("notes", { ...args, createdAt });
		// Same transaction as the insert — the index can never drift.
		await notesSearch.set(ctx, {
			key: noteId,
			text: args.text,
			sortKey: createdAt,
			filters: { category: args.category },
		});
		return noteId;
	},
});

export const updateNote = mutation({
	args: { noteId: v.id("notes"), text: v.string() },
	handler: async (ctx, args) => {
		const note = await ctx.db.get("notes", args.noteId);
		if (note === null) throw new Error("note not found");
		await ctx.db.patch("notes", args.noteId, { text: args.text });
		await notesSearch.set(ctx, {
			key: args.noteId,
			text: args.text,
			sortKey: note.createdAt,
			filters: { category: note.category },
		});
	},
});

export const deleteNote = mutation({
	args: { noteId: v.id("notes") },
	handler: async (ctx, args) => {
		await ctx.db.delete("notes", args.noteId);
		await notesSearch.remove(ctx, { key: args.noteId });
	},
});

/**
 * Exact substring search — CJK, emoji, whatever. Reactive like any Convex
 * query. A non-null cursor with a short page means "budget spent, keep
 * paging"; only isDone means exhausted.
 */
export const searchNotes = query({
	args: {
		query: v.string(),
		category: v.optional(v.union(v.literal("work"), v.literal("personal"))),
		cursor: v.optional(v.union(v.string(), v.null())),
	},
	handler: async (ctx, args) => {
		const result = await notesSearch.search(ctx, {
			query: args.query,
			filters: args.category === undefined ? undefined : { category: args.category },
			cursor: args.cursor,
			limit: 20,
		});
		const page = await Promise.all(
			result.page.map(async ({ key }) => {
				const note = await ctx.db.get("notes", key as import("./_generated/dataModel.js").Id<"notes">);
				return note === null ? null : { _id: note._id, text: note.text, category: note.category };
			}),
		);
		return {
			page: page.filter((note) => note !== null),
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
