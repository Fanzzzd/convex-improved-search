import { getConvexSize, type Value } from "convex/values";

// Fixed property-name/type costs come from the SDK itself. Only validated
// stored-row layouts take these paths; unknown or future layouts use the SDK.
const EMPTY_STRING = getConvexSize("");
const EMPTY_OBJECT = getConvexSize({});
const POST_BASE = getConvexSize({
	namespace: "",
	key: "",
	sortKey: 0,
	gram: "",
	g1: "",
	_id: "",
	_creationTime: 0,
});
const DOC_BASE = getConvexSize({
	namespace: "",
	key: "",
	sortKey: 0,
	fields: {},
	_id: "",
	_creationTime: 0,
});
const FIELD_KEY =
	getConvexSize({ fields: [] }) - EMPTY_OBJECT - getConvexSize([]);
const FILTER_KEY = getConvexSize({ filters: {} }) - 2 * EMPTY_OBJECT;

type Base = {
	namespace: string;
	key: string;
	sortKey: number;
	_id: string;
	_creationTime: number;
};
type Stored = Base & {
	gram?: string;
	g1?: string;
	fields?: Value;
	filters?: Value;
};

/** Exact SDK value size, with fixed-layout paths avoiding repeated property-name work. */
export function rowSize(row: object): number {
	const r = row as Stored;
	if (
		typeof r.namespace !== "string" ||
		typeof r.key !== "string" ||
		typeof r._id !== "string" ||
		typeof r.sortKey !== "number" ||
		typeof r._creationTime !== "number"
	)
		return getConvexSize(row as Value);
	const proto = Object.getPrototypeOf(row);
	if (proto !== null && proto !== Object.prototype)
		return getConvexSize(row as Value);
	const keys = Object.keys(row);
	const shared =
		getConvexSize(r.namespace) +
		getConvexSize(r.key) +
		getConvexSize(r._id) -
		3 * EMPTY_STRING;
	if (
		typeof r.gram === "string" &&
		typeof r.g1 === "string" &&
		keys.length === 7 + (r.fields === undefined ? 0 : 1)
	) {
		return (
			POST_BASE +
			shared +
			getConvexSize(r.gram) +
			getConvexSize(r.g1) -
			2 * EMPTY_STRING +
			(r.fields === undefined ? 0 : FIELD_KEY + getConvexSize(r.fields))
		);
	}
	if (
		r.fields !== undefined &&
		r.gram === undefined &&
		r.g1 === undefined &&
		keys.length === 6 + (r.filters === undefined ? 0 : 1)
	) {
		return (
			DOC_BASE +
			shared +
			getConvexSize(r.fields) -
			EMPTY_OBJECT +
			(r.filters === undefined ? 0 : FILTER_KEY + getConvexSize(r.filters))
		);
	}
	return getConvexSize(row as Value);
}
