import { expect, test } from "vitest";
import { callRoute } from "../testing/route-context.ts";
import { PASS } from "./table.ts";
import { createCalendarWebhookRoutes, type CalendarWebhookRouteDeps, type WebhookIngressStatus } from "./calendar-webhooks.ts";

const visibleOnly = (...ids: string[]) =>
  ({ everything: false, bot: (id: string) => ids.includes(id), group: () => false }) as never;

const bot = (id: string, name: string, visibility: string) => ({ id, name, visibility });

const deps = (): CalendarWebhookRouteDeps => {
  const bots: Record<string, { id: string; name: string; visibility: string }> = {
    alpha: bot("alpha", "Alpha", "everyone"),
    beta: bot("beta", "Beta", "everyone"),
    locked: bot("locked", "Locked", "admins"),
  };
  return {
    calendarCalls: () => ({
      list: () => [{ id: "call-1" }],
      get: (id: string) => (id === "call-1" ? { id } : undefined),
      create: (body: unknown) => {
        if (!body || typeof body !== "object" || !("prompt" in body)) throw new Error("Give the call a prompt");
        return { id: "call-2", ...(body as object) };
      },
      update: (id: string, body: unknown) => (id === "call-1" ? { id, ...(body as object) } : undefined),
      remove: (id: string) => id === "call-1",
    }),
    webhooks: {
      list: () => [
        { id: "hook-mine", botId: "alpha", endpointId: "ep-mine" },
        { id: "hook-theirs", botId: "locked", endpointId: "ep-theirs" },
      ],
      listAttempts: () => [{ webhookId: "hook-mine" }, { webhookId: "hook-theirs" }],
      create: () => ({ webhook: { id: "hook-new", botId: "alpha", endpointId: "ep-new" }, secret: "s3cret" }),
      rotateSecret: (id: string) => (id === "hook-mine" ? { webhook: { id, endpointId: "ep-mine" }, secret: "new-secret" } : undefined),
      test: (id: string) => (id === "hook-mine" ? { accepted: true } : undefined),
      update: (id: string, b: unknown) => (id === "hook-mine" ? { id, ...(b as object) } : undefined),
      remove: (id: string) => id === "hook-mine",
    } as never,
    webhookIngressStatus: (): WebhookIngressStatus => ({ available: true, baseUrl: "http://127.0.0.1:8790/" }),
    store: { bot: (id: string) => bots[id] } as never,
    visibleFor: () => visibleOnly("alpha", "beta"),
  } as unknown as CalendarWebhookRouteDeps;
};

const call = async (handler: ReturnType<typeof createCalendarWebhookRoutes>, path: string, method = "GET", body: unknown = {}) => {
  const { ctx, sent } = callRoute(path, method, body);
  const out = await handler(ctx);
  return { out, sent };
};

test("a request that is not its own is left to the next handler", async () => {
  const { out, sent } = await call(createCalendarWebhookRoutes(deps()), "/api/health");

  expect(out).toBe(PASS);
  expect(sent).toEqual([]);
});

test("a call with bots that do not share an audience is refused, naming the pair", async () => {
  const { sent } = await call(createCalendarWebhookRoutes(deps()), "/api/calendar-calls", "POST", {
    botIds: ["alpha", "locked"],
    prompt: "stand-up",
  });

  expect(sent[0]?.status).toBe(400);
  expect((sent[0]?.body as { error?: string } | undefined)?.error).toMatch(/Alpha and Locked are not/);
});

test("one bot, or bots with the same audience, is allowed through", async () => {
  const handler = createCalendarWebhookRoutes(deps());
  const two = await call(handler, "/api/calendar-calls", "POST", { botIds: ["alpha", "beta"], prompt: "stand-up" });
  const one = await call(handler, "/api/calendar-calls", "POST", { botIds: ["alpha"], prompt: "focus" });

  expect(two.sent[0]?.status).toBe(201);
  expect(one.sent[0]?.status).toBe(201);
});

test("what the manager refuses is a 400 to the caller, not a crash", async () => {
  const handler = createCalendarWebhookRoutes(deps());

  await expect(call(handler, "/api/calendar-calls", "POST", { botIds: ["alpha"] }))
    .rejects.toMatchObject({ status: 400, message: "Give the call a prompt" });
});

test("editing and deleting a call answer for the call named", async () => {
  const handler = createCalendarWebhookRoutes(deps());
  const patched = await call(handler, "/api/calendar-calls/call-1", "PATCH", { prompt: "later" });
  const missing = await call(handler, "/api/calendar-calls/gone", "PATCH", { prompt: "later" });
  const removed = await call(handler, "/api/calendar-calls/call-1", "DELETE");
  const gone = await call(handler, "/api/calendar-calls/gone", "DELETE");

  expect(patched.sent[0]?.status).toBe(200);
  expect(missing.sent).toEqual([{ status: 404, body: { error: "no such scheduled call" } }]);
  expect(removed.sent).toEqual([{ status: 200, body: { ok: true } }]);
  expect(gone.sent[0]?.status).toBe(404);
});

test("a webhook list shows only the hooks and attempts the viewer may see", async () => {
  const { sent } = await call(createCalendarWebhookRoutes(deps()), "/api/webhooks");

  const body = sent[0]?.body as { webhooks: Array<{ id: string }>; attempts: Array<{ webhookId: string }> };
  expect(body.webhooks.map((hook) => hook.id)).toEqual(["hook-mine"]);
  expect(body.attempts.map((attempt) => attempt.webhookId)).toEqual(["hook-mine"]);
});

test("creating and rotating a hook hand back the URL a sender needs", async () => {
  const handler = createCalendarWebhookRoutes(deps());
  const created = await call(handler, "/api/webhooks", "POST", { botId: "alpha" });
  const rotated = await call(handler, "/api/webhooks/hook-mine/rotate", "POST");
  const missing = await call(handler, "/api/webhooks/gone/rotate", "POST");

  const credential = (created.sent[0]?.body as { credential?: { url: string; endpointUrl: string } } | undefined)?.credential;
  expect(created.sent[0]?.status).toBe(201);
  // the trailing slash on the ingress base is not doubled in the URL
  expect(credential?.endpointUrl).toBe("http://127.0.0.1:8790/hooks/ep-new");
  expect(credential?.url).toBe("http://127.0.0.1:8790/hooks/ep-new/s3cret");
  expect(rotated.sent[0]?.status).toBe(200);
  expect(missing.sent).toEqual([{ status: 404, body: { error: "no such webhook" } }]);
});

test("testing, editing and deleting a hook answer for the hook named", async () => {
  const handler = createCalendarWebhookRoutes(deps());
  const tested = await call(handler, "/api/webhooks/hook-mine/test", "POST", { payload: 1 });
  const noTest = await call(handler, "/api/webhooks/gone/test", "POST");
  const patched = await call(handler, "/api/webhooks/hook-mine", "PATCH", { enabled: false });
  const removed = await call(handler, "/api/webhooks/hook-mine", "DELETE");
  const gone = await call(handler, "/api/webhooks/gone", "DELETE");

  expect(tested.sent).toEqual([{ status: 202, body: { accepted: true } }]);
  expect(noTest.sent[0]?.status).toBe(404);
  expect(patched.sent[0]?.status).toBe(200);
  expect(removed.sent).toEqual([{ status: 200, body: { ok: true } }]);
  expect(gone.sent[0]?.status).toBe(404);
});