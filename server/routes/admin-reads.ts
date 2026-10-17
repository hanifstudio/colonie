// Admin read-only surfaces: the authorization decision log, subscription
// windows, the provider key check, admin activity (JSON and CSV), and the
// decision log as CSV. Everything here is admin scope by default — none of it
// is in CLIENT_ALLOW and none of it is a service route.
//
// The decision-log reads are read-only: the rows were written at the
// request.opened fold and in answerRequest; these routes only read them back,
// newest last, same order as thread events.
import {
  loadPlanUsage,
  planAccountsFromInstances,
} from "../plan-usage.ts";
import { checkProviderKey, PROVIDER_KEY_KINDS, providerBaseUrl, type ProviderKeyKind } from "../provider-key-check.ts";
import { noteKeyAccepted, noteKeyRejected } from "../key-rejections.ts";
import {
  boundRetentionDays,
  decisionsCsv,
  readDecisionRange,
  readDecisions,
} from "../decision-log.ts";
import { parseUsageRange } from "../usage-ledger.ts";
import {
  activityCsv,
  activityEntries,
  parseActivityWhat,
  readAdminActivityRange,
} from "../admin-activity.ts";
import { DATA_DIR, instanceConfigs, type loadConfig } from "../config.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface AdminReadRouteDeps {
  cfg: ReturnType<typeof loadConfig>;
  /** True where several people share the workspace; index.ts owns the rule. */
  adminActivityRecording: () => boolean;
}

export function createAdminReadRoutes(deps: AdminReadRouteDeps): RouteHandler {
  return async ({ req, res, url, path, method, json, readBody }) => {
    // Subscription windows (5-hour and weekly), not the token ledger.
    // Same admin gate as /api/usage: this route is unlisted, so it stays admin.
    if (method === "GET" && path === "/api/plan-usage") {
      res.setHeader("cache-control", "no-store");
      const report = await loadPlanUsage({
        accounts: planAccountsFromInstances(instanceConfigs(deps.cfg)),
        refresh: url.searchParams.get("refresh") === "1",
      });
      return json(res, 200, report);
    }

    // ── provider key check: does a pasted or saved key open the provider's door ──
    // One read-only request from this server; the verdict never carries the
    // key. Admin scope by default, like every route not opened to clients.
    if (method === "POST" && path === "/api/keys/test") {
      const body = await readBody(req, 8192);
      const provider = body?.provider;
      if (!PROVIDER_KEY_KINDS.includes(provider as ProviderKeyKind)) {
        return json(res, 400, { error: `provider must be one of ${PROVIDER_KEY_KINDS.join(", ")}` });
      }
      const kind = provider as ProviderKeyKind;
      const saved = { anthropic: deps.cfg.anthropic, openai: deps.cfg.openai, openrouter: deps.cfg.openrouter, openaiCompat: deps.cfg.openaiCompat, mistral: deps.cfg.mistral, cerebras: deps.cfg.cerebras, xai: deps.cfg.xai }[kind];
      if (body?.key !== undefined && typeof body.key !== "string") {
        return json(res, 400, { error: "key must be a string" });
      }
      const key = typeof body?.key === "string" ? body.key.trim() : saved?.key?.trim() || "";
      if (!key) return json(res, 400, { error: "No key to test. Paste one or save one first." });
      if (key.length > 512) return json(res, 400, { error: "That does not look like an API key." });
      const keyUrl = typeof body?.url === "string" && body.url.trim() ? body.url.trim() : (saved && "url" in saved ? saved.url : undefined);
      res.setHeader("cache-control", "no-store");
      const verdict = await checkProviderKey({ provider: kind, key, url: keyUrl });
      // A Test is a real use the person chose: the engines on this key agree
      // with its verdict. Claude runs its key through its CLI, not here.
      if (kind !== "anthropic") {
        const base = providerBaseUrl(kind, keyUrl);
        if (verdict.ok) noteKeyAccepted(base, key);
        else if (verdict.reason === "rejected") noteKeyRejected(base, key);
      }
      return json(res, 200, verdict);
    }

    if (method === "GET" && path === "/api/decisions") {
      const rawLimit = url.searchParams.get("limit");
      const parsedLimit = rawLimit === null ? undefined : Number(rawLimit);
      if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit <= 0)) {
        return json(res, 400, { error: "limit must be a positive whole number" });
      }
      return json(res, 200, { decisions: readDecisions(DATA_DIR, parsedLimit ?? 200) });
    }
    // Settings → Activity: admin actions and approvals together, filtered by
    // who, what and when; the same list as CSV. Admin scope by default.
    if (method === "GET" && (path === "/api/admin-activity" || path === "/api/admin-activity.csv")) {
      const fromParam = url.searchParams.get("from") || new Date(Date.now() - 29 * 24 * 60 * 60_000).toISOString().slice(0, 10);
      const range = parseUsageRange(fromParam, url.searchParams.get("to"));
      if (!range) return json(res, 400, { error: "from and to must be dates (YYYY-MM-DD), from no later than to, at most a year apart" });
      const what = parseActivityWhat(url.searchParams.get("what"));
      if (!what) return json(res, 400, { error: "what must be all, approvals, decisions, config, people, session, webhook, mcp, engine, bot, budget or visibility" });
      const entries = activityEntries(readDecisionRange(DATA_DIR, range), readAdminActivityRange(DATA_DIR, range), {
        what,
        who: (url.searchParams.get("who") ?? "").slice(0, 200),
      });
      if (path.endsWith(".csv")) {
        const stamp = (date: Date) => date.toISOString().slice(0, 10);
        res.writeHead(200, {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="activity-${stamp(range.from)}-${stamp(range.to)}.csv"`,
          "cache-control": "no-store",
        });
        res.end(activityCsv(entries));
        return;
      }
      const rawLimit = Number(url.searchParams.get("limit") ?? 500);
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 5_000) : 500;
      res.setHeader("cache-control", "no-store");
      return json(res, 200, {
        entries: entries.slice(0, limit),
        total: entries.length,
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        retentionDays: boundRetentionDays(),
        recording: deps.adminActivityRecording(),
      });
    }
    // The same rows for an auditor's spreadsheet, over a date range. Admin
    // scope by default (not in CLIENT_ALLOW, not a service route).
    if (method === "GET" && path === "/api/decisions.csv") {
      const range = parseUsageRange(url.searchParams.get("from"), url.searchParams.get("to"));
      if (!range) return json(res, 400, { error: "from and to must be YYYY-MM-DD, from no later than to, at most a year apart" });
      const stamp = (date: Date) => date.toISOString().slice(0, 10);
      res.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="decisions-${stamp(range.from)}-${stamp(range.to)}.csv"`,
        "cache-control": "no-store",
      });
      res.end(decisionsCsv(readDecisionRange(DATA_DIR, range)));
      return;
    }
    return PASS;
  };
}