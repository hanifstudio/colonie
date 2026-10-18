// The admin-activity audit: plan what a request may change from its method and path, capture the before state, and record one row per change once the request answers successfully, plus the guarded-send contract the Slack worker opts into.
import { type WebhookTrigger } from "../../shared/webhooks.ts";
import { type AdminActionRow, appendAdminAction, botAuditSnapshot, botChangeRows } from "../admin-activity.ts";
import { DATA_DIR } from "../config.ts";
import { onJsonBody, parsedBodyOf } from "../harness/http.ts";
import { type RequestAuth, requiredScope } from "../request-auth.ts";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";

/** Everything this cluster reaches in the server; see the header. */
export interface AdminAuditDeps {
  // ponytail: one permissive shape instead of hand-typed lines for each name;
  // tighten it when this cluster gets tests of its own.
  [name: string]: any;
}

export function createAdminAudit(deps: AdminAuditDeps) {
  const {
    DESKTOP_MANAGED, adminActivityRecording, adminActorFor, adminActorScope, lendingEnabled,
    sessions, store, webhooks
  } = deps;
interface AuditPlan {
  /** An admin-scope change: config saves made while it runs are recorded. */
  config: boolean;
  /** A bot whose permissions or audience this request may change. */
  botId?: string;
  createsBots: boolean;
  deletesBot?: string;
  createsWebhook: boolean;
  /** A webhook changed, deleted or given a new secret by id. */
  webhookId?: string;
  sessionId?: string;
  engineAction?: { id: string; action: string };
}

function adminAuditPlan(method: string, path: string): AuditPlan | null {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return null;
  if (path.startsWith("/api/testing/")) return null;
  const plan: AuditPlan = {
    config: requiredScope(method, path, { sharedComputers: lendingEnabled() }) === "admin",
    createsBots: method === "POST" && (path === "/api/bots" || path === "/api/teams/import"),
    createsWebhook: method === "POST" && path === "/api/webhooks",
  };
  let m = /^\/api\/bots\/([\w-]+)(?:\/(always-allow|model))?$/.exec(path);
  if (m && ((!m[2] && method === "PATCH") || (m[2] === "model" && method === "PATCH") || (m[2] === "always-allow" && method === "POST"))) plan.botId = m[1];
  if (m && !m[2] && method === "DELETE") plan.deletesBot = m[1];
  m = /^\/api\/webhooks()\/([\w-]+)(\/rotate)?$/.exec(path);
  if (m && ((m[2] && method === "POST") || (!m[2] && (method === "PATCH" || method === "DELETE")))) plan.webhookId = m[1];
  m = /^\/api\/auth\/sessions\/([\w-]+)$/.exec(path);
  if (m && method === "DELETE") plan.sessionId = m[1];
  m = /^\/api\/instances\/([\w.-]+)\/(install|auth\/complete|auth\/sign-out|leftover-files\/remove)$/.exec(path);
  if (m && method === "POST") plan.engineAction = { id: m[1]!, action: m[2]!.replace("/", "-") };
  if (method === "POST" && path === "/api/instances/claude-accounts") plan.engineAction = { id: "claude", action: "account-add" };
  if (method === "POST" && path === "/api/instances/chatgpt-accounts") plan.engineAction = { id: "chatgpt", action: "account-add" };
  return plan.config || plan.botId || plan.createsBots || plan.deletesBot || plan.createsWebhook || plan.webhookId || plan.sessionId || plan.engineAction ? plan : null;
}

const WEBHOOK_AUDIT_FIELDS = ["name", "prompt", "botId", "runOn", "enabled", "eventTypes"] as const;
const auditBot = (id: string | undefined) => (id ? botAuditSnapshot(store().bot(id) as unknown as Record<string, unknown> | null) : null);
const auditHook = (id: string | undefined) => (id ? webhooks().list().find((hook: WebhookTrigger) => hook.id === id) : undefined);
const hookFields = (hook: WebhookTrigger, fields: readonly string[] = WEBHOOK_AUDIT_FIELDS) =>
  Object.fromEntries(fields.map((field) => [field, (hook as unknown as Record<string, unknown>)[field] ?? null]));

/** The bot fields a PATCH named: only those are compared, so a concurrent
 * change to another field is not put down to this request. */
function requestedBotFields(req: IncomingMessage, path: string): string[] {
  if (path.endsWith("/always-allow")) return ["alwaysAllow"];
  if (path.endsWith("/model")) return ["modelSelection"];
  const body = parsedBodyOf(req);
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const fields = new Set(Object.keys(body));
  if (fields.has("autoApprove") || fields.has("approvalMode")) fields.add("autoApprove").add("approvalMode");
  if (fields.has("chiefOfStaff")) fields.add("managedSections");
  return [...fields];
}

/** Record this request's admin changes once it has answered successfully.
 * Each row compares only what this request named or created, never a whole
 * snapshot, so another admin's change made meanwhile is not attributed here. */
function beginAdminAudit(req: IncomingMessage, res: ServerResponse, method: string, path: string, auth: RequestAuth): void {
  const plan = DESKTOP_MANAGED ? null : adminAuditPlan(method, path);
  const actor = plan ? adminActorFor(auth, req) : null;
  // Whether several people share the workspace as the request begins: a
  // change that ends sharing (the last chat-only phone signed out) is kept.
  const sharedAtStart = plan ? adminActivityRecording() : false;
  // Set for every request, so a kept-alive connection never inherits one.
  adminActorScope.enterWith(plan?.config && actor ? { actor, sharedAtStart } : null);
  if (!plan || !actor) return;
  const before = {
    bot: auditBot(plan.botId ?? plan.deletesBot),
    botName: store().bot(plan.botId ?? plan.deletesBot ?? "")?.name,
    hook: auditHook(plan.webhookId),
    session: plan.sessionId ? sessions.list().find((session: any) => session.id === plan.sessionId) : undefined,
  };
  let answered: unknown;
  if (plan.createsBots || plan.createsWebhook) onJsonBody(res, (body) => (answered = body));
  res.once("finish", () => {
    if (res.statusCode >= 400 || (!sharedAtStart && !adminActivityRecording())) return;
    try {
      for (const row of adminAuditRows(plan, req, path, before, answered)) appendAdminAction(DATA_DIR, { ...row, actor });
    } catch (error) {
      console.warn(`admin activity: could not record ${method} ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

function adminAuditRows(
  plan: AuditPlan,
  req: IncomingMessage,
  path: string,
  before: { bot: Record<string, unknown> | null; botName?: string; hook?: WebhookTrigger; session?: ReturnType<typeof sessions.list>[number] },
  answered: unknown,
): Array<Omit<AdminActionRow, "at" | "actor">> {
  const rows: Array<Omit<AdminActionRow, "at" | "actor">> = [];
  const reply = answered && typeof answered === "object" ? answered as Record<string, unknown> : {};
  const idOf = (value: unknown) => (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string" ? (value as { id: string }).id : undefined);
  if (plan.botId) {
    rows.push(...botChangeRows({ id: plan.botId, name: store().bot(plan.botId)?.name }, before.bot, auditBot(plan.botId), requestedBotFields(req, path)));
  }
  if (plan.createsBots) {
    const created = [idOf(reply.bot), ...(Array.isArray(reply.bots) ? reply.bots.map(idOf) : [])].filter((id): id is string => Boolean(id));
    for (const id of new Set(created)) {
      const fields = auditBot(id);
      if (fields) rows.push({ category: "bot", action: "bot.create", target: { kind: "bot", id, name: store().bot(id)!.name }, after: fields });
    }
  }
  if (plan.deletesBot && before.bot && !store().bot(plan.deletesBot)) {
    rows.push({ category: "bot", action: "bot.delete", target: { kind: "bot", id: plan.deletesBot, ...(before.botName ? { name: before.botName } : {}) }, before: before.bot });
  }
  const hookTarget = (hook: WebhookTrigger) => ({ kind: "webhook", id: hook.id, name: hook.name });
  if (plan.createsWebhook) {
    const hook = auditHook(idOf(reply.webhook));
    if (hook) rows.push({ category: "webhook", action: "webhook.create", target: hookTarget(hook), after: hookFields(hook) });
  }
  if (plan.webhookId && before.hook) {
    const after = auditHook(plan.webhookId);
    if (!after) rows.push({ category: "webhook", action: "webhook.delete", target: hookTarget(before.hook), before: hookFields(before.hook) });
    else if (path.endsWith("/rotate")) rows.push({ category: "webhook", action: "webhook.rotate-secret", target: hookTarget(after) });
    else {
      const body = parsedBodyOf(req);
      const named = body && typeof body === "object" ? Object.keys(body) : [];
      const changed = WEBHOOK_AUDIT_FIELDS.filter((field) => named.includes(field) &&
        JSON.stringify(hookFields(before.hook!, [field])) !== JSON.stringify(hookFields(after, [field])));
      if (changed.length) {
        rows.push({ category: "webhook", action: "webhook.update", target: hookTarget(after), changed: [...changed], before: hookFields(before.hook, changed), after: hookFields(after, changed) });
      }
    }
  }
  if (before.session && !sessions.list().some((session: any) => session.id === before.session!.id)) {
    const session = before.session;
    rows.push({ category: "session", action: "session.revoke", target: { kind: "session", id: session.id, name: session.email ?? session.label },
      before: { label: session.label, ...(session.email ? { email: session.email } : {}), scopes: session.scopes } });
  }
  if (plan.engineAction) rows.push({ category: "engine", action: `engine.${plan.engineAction.action}`, target: { kind: "engine", id: plan.engineAction.id } });
  return rows;
}

/** The guarded send contract external interfaces (the Slack worker) opt into.
 * `onBehalfOf` is additive and advertised by /api/health
 * (capabilities.guardedOnBehalfOf): it names the person a relay acts for, so
 * the turn is booked to them rather than to this machine. Only this
 * admin-scoped route reads it; every other send is booked to its own
 * session. */
const guardedSendSchema = z.object({
  threadId: z.string().regex(/^[\w-]+$/),
  sendId: z.string().regex(/^[A-Za-z0-9_-]{16,80}$/),
  text: z.string().min(1),
  expectedActiveLeafId: z.string().regex(/^[\w-]+$/).nullable(),
  expectedApprovalMode: z.enum(["ask", "full"]).optional(),
  replyToId: z.string().optional(),
  onBehalfOf: z.object({
    email: z.string().trim().toLowerCase().max(254).pipe(z.email()).optional(),
    name: z.string().trim().min(1).max(120).optional(),
  }).strict().refine((who) => Boolean(who.email || who.name)).optional(),
}).strict();

  return {
    beginAdminAudit,
    guardedSendSchema,
  };
}
