import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
	notes: defineTable({
		text: v.string(),
		category: v.union(v.literal("work"), v.literal("personal")),
		createdAt: v.number(),
	}),
});
