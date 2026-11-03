import { expect, test } from "vitest";
import { getConvexSize, type Value } from "convex/values";
import { rowSize } from "./rowSize.js";

const strings = ["", "ascii", "香港😀", 'x\u0000"\\', "é", "x".repeat(800)];
test("fixed-layout sizes equal the SDK including fallback layouts", () => {
	const rows: object[] = [];
	for (let i = 0; i < 5000; i++) {
		const base = {
			namespace: strings[i % strings.length],
			key: `k${i}`,
			sortKey: [0, -0, 1e100, -7.5][i % 4],
			_id: "i".repeat(31 + (i % 3)),
			_creationTime: 1760000000000 + i,
		};
		const fields = {
			text: strings[(i + 1) % strings.length],
			constructor: strings[(i + 2) % strings.length],
		};
		const doc = {
			...base,
			fields,
			...(i % 2
				? {
						filters: {
							n: i % 3 ? 0 : -0,
							s: strings[i % strings.length],
							b: true,
							z: null,
						},
					}
				: {}),
		};
		const posting = {
			...base,
			gram: strings[(i + 3) % strings.length],
			g1: strings[(i + 4) % strings.length],
			...(i % 2 ? { fields: ["text", "constructor"] } : {}),
		};
		rows.push(doc, posting);
		if (i < 12)
			rows.push(
				{ ...doc, future: "unknown" },
				{ ...posting, future: 7 },
				{ ...doc, fields: undefined },
				{ ...posting, fields: undefined },
				{ sortKey: 3, key: "synthetic" },
			);
	}
	rows.push(
		Object.assign(Object.create(null), {
			namespace: "n",
			key: "k",
			sortKey: 0,
			fields: { text: "a" },
			_id: "i",
			_creationTime: 0,
		}),
	);
	for (const row of rows)
		expect(rowSize(row)).toBe(getConvexSize(row as Value));
});
