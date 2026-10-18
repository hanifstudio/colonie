// Owner/admin HTTP surface for the Colonie memory ledger. Small factory with
// explicit deps, strict Zod bodies and a recheck at the write boundary: body
// reading can yield while an edit or a bot deletion lands, so `exists` is
// asked again before the store is touched. Read routes are owner-gated too —
// a session-less service caller cannot reach memory.
import { z } from "zod";
import { PASS, type RouteHandler } from "../../../routes/table.ts";
import type { ColonieMemoryService } from "./service.ts";

const preferencesSchema = z.object({ enabled: z.boolean(), automatic: z.boolean() }).strict();
const scopeSchema = z.enum(["shared", "bot"]);
const kindSchema = z.enum(["preference", "fact", "decision"]);
const untilSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "A calendar date in YYYY-MM-DD form.");

interface Dependencies {
  service: ColonieMemoryService;
  exists(botId: string): boolean;
  /** The base per-bot switch; called only when a bot-scope enabled choice
   * changes, so a starter bot saved memory-off can be turned back on. */
  setBotMemoryEnabled?(botId: string, enabled: boolean): void;
  changed?(botId: string): void;
}

const BASE = /^\/api\/bots\/([\w-]+)\/colonie-memory$/;
const PREFERENCES = /^\/api\/bots\/([\w-]+)\/colonie-memory\/preferences$/;
const ENTRIES = /^\/api\/bots\/([\w-]+)\/colonie-memory\/entries$/;
const ENTRY = /^\/api\/bots\/([\w-]+)\/colonie-memory\/entries\/([\w-]+)$/;
const CLEAR = /^\/api\/bots\/([\w-]+)\/colonie-memory\/clear$/;

function statusOf(error: unknown): number {
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : 400;
}

export function createColonieMemoryRoutes(deps: Dependencies): RouteHandler {
  return async (ctx) => {
    let botId: string | undefined;
    let entryId: string | undefined;
    let route: "view" | "preferences" | "create" | "update" | "delete" | "clear" | undefined;
    if (ctx.method === "GET" && BASE.test(ctx.path)) {
      botId = BASE.exec(ctx.path)![1];
      route = "view";
    } else if (ctx.method === "PATCH" && PREFERENCES.test(ctx.path)) {
      botId = PREFERENCES.exec(ctx.path)![1];
      route = "preferences";
    } else if (ctx.method === "POST" && ENTRIES.test(ctx.path)) {
      botId = ENTRIES.exec(ctx.path)![1];
      route = "create";
    } else if (ctx.method === "PATCH" && ENTRY.test(ctx.path)) {
      botId = ENTRY.exec(ctx.path)![1];
      entryId = ENTRY.exec(ctx.path)![2];
      route = "update";
    } else if (ctx.method === "DELETE" && ENTRY.test(ctx.path)) {
      botId = ENTRY.exec(ctx.path)![1];
      entryId = ENTRY.exec(ctx.path)![2];
      route = "delete";
    } else if (ctx.method === "POST" && CLEAR.test(ctx.path)) {
      botId = CLEAR.exec(ctx.path)![1];
      route = "clear";
    }
    if (!route || !botId) return PASS;

    const owner = ctx.auth.kind === "loopback" ? ctx.auth.trust !== "service" : ctx.auth.scopes.includes("admin");
    if (!owner) {
      ctx.json(ctx.res, 403, { error: "Only the workspace owner/admin can manage memory." });
      return;
    }
    if (!deps.exists(botId)) {
      ctx.json(ctx.res, 404, { error: "No such bot" });
      return;
    }

    try {
      const changed = () => deps.changed?.(botId!);
      if (route === "view") {
        ctx.json(ctx.res, 200, deps.service.view(botId));
        return;
      }
      if (route === "preferences") {
        const parsed = z
          .object({ scope: scopeSchema, preferences: preferencesSchema, expectedRevision: z.string().min(1) })
          .strict()
          .safeParse(await ctx.readBody(ctx.req));
        if (!parsed.success) {
          ctx.json(ctx.res, 400, { error: "Invalid memory preferences." });
          return;
        }
        if (!deps.exists(botId)) {
          ctx.json(ctx.res, 404, { error: "No such bot" });
          return;
        }
        deps.service.updatePreferences(botId, parsed.data.scope, parsed.data.preferences, parsed.data.expectedRevision);
        if (parsed.data.scope === "bot") deps.setBotMemoryEnabled?.(botId, parsed.data.preferences.enabled);
        changed();
        ctx.json(ctx.res, 200, deps.service.view(botId));
        return;
      }
      if (route === "create") {
        const parsed = z
          .object({
            entry: z.object({ scope: scopeSchema, text: z.string().min(1), kind: kindSchema, key: z.string().min(1).optional(), until: untilSchema.optional() }).strict(),
            expectedRevision: z.string().min(1),
          })
          .strict()
          .safeParse(await ctx.readBody(ctx.req));
        if (!parsed.success) {
          ctx.json(ctx.res, 400, { error: "Invalid memory entry." });
          return;
        }
        if (!deps.exists(botId)) {
          ctx.json(ctx.res, 404, { error: "No such bot" });
          return;
        }
        deps.service.saveEntry(botId, parsed.data.entry, parsed.data.expectedRevision);
        changed();
        ctx.json(ctx.res, 200, deps.service.view(botId));
        return;
      }
      if (route === "update") {
        const parsed = z
          .object({ text: z.string().min(1), kind: kindSchema.optional(), until: untilSchema.nullable().optional(), expectedRevision: z.string().min(1) })
          .strict()
          .safeParse(await ctx.readBody(ctx.req));
        if (!parsed.success) {
          ctx.json(ctx.res, 400, { error: "Invalid memory edit." });
          return;
        }
        if (!deps.exists(botId)) {
          ctx.json(ctx.res, 404, { error: "No such bot" });
          return;
        }
        const view = deps.service.view(botId);
        const existing = view.entries.find((entry) => entry.id === entryId);
        if (!existing) {
          ctx.json(ctx.res, 404, { error: "That memory no longer exists." });
          return;
        }
        deps.service.saveEntry(
          botId,
          {
            scope: existing.scope,
            id: entryId!,
            text: parsed.data.text,
            kind: parsed.data.kind ?? existing.kind,
            ...(parsed.data.until !== undefined ? { until: parsed.data.until ?? undefined } : existing.until ? { until: existing.until } : {}),
          },
          parsed.data.expectedRevision,
        );
        changed();
        ctx.json(ctx.res, 200, deps.service.view(botId));
        return;
      }
      if (route === "delete") {
        const expectedRevision = ctx.url.searchParams.get("expectedRevision");
        if (!expectedRevision) {
          ctx.json(ctx.res, 400, { error: "expectedRevision is required." });
          return;
        }
        deps.service.forgetEntry(botId, entryId!, expectedRevision);
        changed();
        ctx.json(ctx.res, 200, deps.service.view(botId));
        return;
      }
      // clear
      const parsed = z
        .object({ scope: scopeSchema, expectedRevision: z.string().min(1) })
        .strict()
        .safeParse(await ctx.readBody(ctx.req));
      if (!parsed.success) {
        ctx.json(ctx.res, 400, { error: "Invalid clear request." });
        return;
      }
      if (!deps.exists(botId)) {
        ctx.json(ctx.res, 404, { error: "No such bot" });
        return;
      }
      deps.service.clear(botId, parsed.data.scope, parsed.data.expectedRevision);
      changed();
      ctx.json(ctx.res, 200, deps.service.view(botId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.json(ctx.res, statusOf(error), { error: message });
    }
  };
}
