// Scheduled room sessions and webhook triggers: the two ways a conversation
// starts without a person typing.
//
// A scheduled call with several bots opens a room, so its bots must share one
// audience before it can be saved — that check (`calendarAudienceConflict`) is
// part of the route, not a screen's job. Webhook management stays on this
// app-only server: actual deliveries land on a second, webhook-only loopback
// listener, so Funnel or a future hosted relay never has to expose the rest of
// Colonie's control surface.
import { sameAudience, type VisibleSet } from "../colonie/bots/bot-visibility.ts";
import type { CalendarCallManager } from "../colonie/routines/calendar-calls.ts";
import { webhookCredential } from "../colonie/routines/webhook-ingress.ts";
import type { WebhookManager } from "../colonie/routines/webhooks.ts";
import type { Store } from "../persistence/store.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface WebhookIngressStatus {
  available: boolean;
  baseUrl: string;
  error?: string;
}

export interface CalendarWebhookRouteDeps {
  calendarCalls: () => CalendarCallManager;
  webhooks: WebhookManager;
  webhookIngressStatus: () => WebhookIngressStatus;
  store: Store;
  visibleFor: (auth: RequestAuth) => VisibleSet;
}

/** Refuse a roster that adds a bot whose audience differs from everyone
 * else's. Existing members may stay while an admin sorts it out. */
function roomAudienceConflict(memberIds: readonly string[], existing: readonly string[], store: Store): string | null {
  const members = memberIds.flatMap((id) => {
    const bot = store.bot(id);
    return bot ? [bot] : [];
  });
  for (const added of members.filter((bot) => !existing.includes(bot.id))) {
    const other = members.find((bot) => bot.id !== added.id && !sameAudience(bot.visibility, added.visibility));
    if (other) {
      return `Bots in one room must be visible to the same people. ${added.name} and ${other.name} are not: give them the same visibility first, or use separate rooms.`;
    }
  }
  return null;
}

/** A scheduled call with several bots opens a room, so its bots keep one audience too. */
function calendarAudienceConflict(body: unknown, store: Store): string | null {
  const botIds = body && typeof body === "object" ? (body as { botIds?: unknown }).botIds : undefined;
  if (!Array.isArray(botIds) || botIds.length < 2 || botIds.some((id) => typeof id !== "string")) return null;
  return roomAudienceConflict(botIds as string[], [], store);
}

export function createCalendarWebhookRoutes(deps: CalendarWebhookRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    const mine =
      path === "/api/calendar-calls" ||
      path.startsWith("/api/calendar-calls/") ||
      path === "/api/webhooks" ||
      path.startsWith("/api/webhooks/");
    if (!mine) return PASS;

    const visible = deps.visibleFor(auth);

    // ── scheduled room sessions ────────────────────────────────────────
    if (path === "/api/calendar-calls" && method === "GET") {
      return json(res, 200, { calls: deps.calendarCalls().list() });
    }
    if (path === "/api/calendar-calls" && method === "POST") {
      try {
        const body = await readBody(req);
        const conflict = calendarAudienceConflict(body, deps.store);
        if (conflict) return json(res, 400, { error: conflict });
        return json(res, 201, { call: deps.calendarCalls().create(body) });
      } catch (error) {
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { status: 400 });
      }
    }
    const calendarCallMatch = path.match(/^\/api\/calendar-calls\/([\w-]+)$/);
    if (calendarCallMatch && method === "PATCH") {
      if (!deps.calendarCalls().get(calendarCallMatch[1])) return json(res, 404, { error: "no such scheduled call" });
      try {
        const body = await readBody(req);
        const conflict = calendarAudienceConflict(body, deps.store);
        if (conflict) return json(res, 400, { error: conflict });
        return json(res, 200, { call: deps.calendarCalls().update(calendarCallMatch[1], body) });
      } catch (error) {
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { status: 400 });
      }
    }
    if (calendarCallMatch && method === "DELETE") {
      return deps.calendarCalls().remove(calendarCallMatch[1])
        ? json(res, 200, { ok: true })
        : json(res, 404, { error: "no such scheduled call" });
    }

    // ── independent webhook triggers ────────────────────────────────────
    if (path === "/api/webhooks" && method === "GET") {
      const shownHooks = deps.webhooks.list().filter((webhook) => visible.bot(webhook.botId));
      const shownIds = new Set(shownHooks.map((webhook) => webhook.id));
      return json(res, 200, { webhooks: shownHooks, attempts: deps.webhooks.listAttempts().filter((attempt) => visible.everything || shownIds.has(attempt.webhookId)), ingress: deps.webhookIngressStatus() });
    }
    if (path === "/api/webhooks" && method === "POST") {
      const created = deps.webhooks.create(await readBody(req));
      const ingress = deps.webhookIngressStatus();
      return json(res, 201, {
        webhook: created.webhook,
        ingress,
        credential: webhookCredential(ingress.baseUrl, created.webhook.endpointId, created.secret),
      });
    }
    let webhookMatch = path.match(/^\/api\/webhooks\/([\w-]+)\/(rotate|test)$/);
    if (webhookMatch && method === "POST") {
      if (webhookMatch[2] === "test") {
        const result = deps.webhooks.test(webhookMatch[1], await readBody(req));
        return result ? json(res, 202, result) : json(res, 404, { error: "no such webhook" });
      }
      const rotated = deps.webhooks.rotateSecret(webhookMatch[1]);
      if (!rotated) return json(res, 404, { error: "no such webhook" });
      const ingress = deps.webhookIngressStatus();
      return json(res, 200, {
        webhook: rotated.webhook,
        ingress,
        credential: webhookCredential(ingress.baseUrl, rotated.webhook.endpointId, rotated.secret),
      });
    }
    webhookMatch = path.match(/^\/api\/webhooks\/([\w-]+)$/);
    if (webhookMatch && method === "PATCH") {
      const webhook = deps.webhooks.update(webhookMatch[1], await readBody(req));
      return webhook ? json(res, 200, { webhook }) : json(res, 404, { error: "no such webhook" });
    }
    if (webhookMatch && method === "DELETE") {
      return deps.webhooks.remove(webhookMatch[1])
        ? json(res, 200, { ok: true })
        : json(res, 404, { error: "no such webhook" });
    }

    return PASS;
  };
}