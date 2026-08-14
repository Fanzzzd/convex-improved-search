/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    lib: {
      clearNamespace: FunctionReference<
        "mutation",
        "internal",
        { cursor?: string | null; namespace: string },
        { cursor: string | null },
        Name
      >;
      get: FunctionReference<
        "query",
        "internal",
        { key: string; namespace: string },
        {
          fields: Record<string, string>;
          filters?: Record<string, string | number | boolean | null>;
          sortKey: number;
        } | null,
        Name
      >;
      remove: FunctionReference<
        "mutation",
        "internal",
        { key: string; namespace: string },
        null,
        Name
      >;
      search: FunctionReference<
        "query",
        "internal",
        {
          budget?: number;
          cursor?: string | null;
          filters?: Record<string, string | number | boolean | null>;
          limit?: number;
          namespace: string;
          query: string;
        },
        {
          cursor: string | null;
          isDone: boolean;
          page: Array<{ key: string; matchedFields: Array<string>; sortKey: number }>;
        },
        Name
      >;
      set: FunctionReference<
        "mutation",
        "internal",
        {
          fields: Array<{ name: string; value: string }>;
          filters?: Record<string, string | number | boolean | null>;
          key: string;
          namespace: string;
          onOverflow?: "truncate" | "error";
          sortKey: number;
        },
        null,
        Name
      >;
    };
  };
