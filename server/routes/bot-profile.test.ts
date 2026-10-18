import { expect, test } from "vitest";
import { PASS } from "./table.ts";
import { createBotProfileRoutes } from "./bot-profile.ts";
import { callRoute } from "../testing/route-context.ts";

const bot = { id: "b1", name: "Ada", soul: "keep this", soulHash: "h1", section: "", hidden: false, createdAt: 1 };

function world(record: Record<string, unknown> | null = bot) {
  const events: unknown[] = [];
  const routes = createBotProfileRoutes({
    store: {
      bot: (id: string) => (record && id === "b1" ? record : undefined),
      setSoul: (id: string, soul: string) => (record && id === "b1" ? { ...record, soul } : undefined),
      patchBot: (id: string, patch: Record<string, unknown>) => (record && id === "b1" ? { ...record, ...patch } : undefined),
    } as never,
    wireBot: (value) => value as never,
    broadcast: (event) => { events.push(event); },
    previewSystemPrompt: () => ({ systemPrompt: "you are Ada" }),
    botOverview: async () => ({ ok: true }),
  });
  return { routes, events };
}

test("declines paths and methods that are not its own", async () => {
  const { routes } = world();

  expect(await routes(callRoute("/api/bots/b1").ctx)).toBe(PASS);
  expect(await routes(callRoute("/api/bots/b1/soul", "PUT").ctx)).toBe(PASS);
});

test("an unknown bot is a 404 on every read", async () => {
  const { routes } = world(null);
  for (const path of ["/api/bots/ghost/soul", "/api/bots/ghost/system-prompt", "/api/bots/ghost/overview", "/api/bots/ghost/history"]) {
    const { ctx, sent } = callRoute(path);
    await routes(ctx);
    expect(sent[0]?.status, path).toBe(404);
  }
});

test("the soul read reports the record, its size and the limit", async () => {
  const { routes } = world();
  const { ctx, sent } = callRoute("/api/bots/b1/soul");

  await routes(ctx);

  expect(sent[0]?.status).toBe(200);
  const body = sent[0]?.body as { soul: string; bytes: number; limit: number; drift: boolean };
  expect(body.soul).toBe("keep this");
  expect(body.bytes).toBe(Buffer.byteLength("keep this", "utf8"));
  expect(body.limit).toBeGreaterThan(0);
  expect(body.drift).toBe(false);
});

test("applying SOUL.md with a stale revision is refused, not guessed", async () => {
  const { routes } = world();
  const { ctx, sent } = callRoute("/api/bots/b1/soul/apply-file", "POST", { expectedRevision: "not-the-revision", fileText: "x" });

  await routes(ctx);

  expect(sent[0]?.status).toBe(409);
});

test("applying a file text that is not what the read returned is refused", async () => {
  const { routes } = world();
  const { ctx, sent } = callRoute("/api/bots/b1/soul");
  await routes(ctx);
  const revision = ((sent[0]?.body ?? {}) as { revision: string }).revision;

  const applied = callRoute("/api/bots/b1/soul/apply-file", "POST", { expectedRevision: revision, fileText: "something else" });
  await routes(applied.ctx);

  expect(applied.sent[0]?.status).toBe(409);
  expect(applied.sent[0]?.body).toMatchObject({ error: expect.stringContaining("changed since you read it") });
});

test("the system prompt preview and the overview answer for a known bot", async () => {
  const { routes } = world();
  const prompt = callRoute("/api/bots/b1/system-prompt");
  const overview = callRoute("/api/bots/b1/overview");

  await routes(prompt.ctx);
  await routes(overview.ctx);

  expect(prompt.sent[0]?.status).toBe(200);
  expect(prompt.sent[0]?.body).toEqual({ systemPrompt: "you are Ada" });
  expect(overview.sent[0]?.status).toBe(200);
});

test("history answers rows and the current revision", async () => {
  const { routes } = world();
  const { ctx, sent } = callRoute("/api/bots/b1/history");

  await routes(ctx);

  expect(sent[0]?.status).toBe(200);
  const body = sent[0]?.body as { rows: unknown[]; revision: string };
  expect(Array.isArray(body.rows)).toBe(true);
  expect(body.revision).toBeTypeOf("string");
});

test("a rollback that names no soul entry is refused", async () => {
  const { routes } = world();
  const read = callRoute("/api/bots/b1/soul");
  await routes(read.ctx);
  const revision = ((read.sent[0]?.body ?? {}) as { revision: string }).revision;

  const { ctx, sent } = callRoute("/api/bots/b1/history/rollback", "POST", { expectedRevision: revision, id: "nope" });
  await routes(ctx);

  expect(sent[0]?.status).toBe(400);
  expect(sent[0]?.body).toMatchObject({ error: expect.stringContaining("SOUL.md") });
});

test("a rollback with a stale revision is refused before it looks at the entry", async () => {
  const { routes } = world();
  const { ctx, sent } = callRoute("/api/bots/b1/history/rollback", "POST", { expectedRevision: "stale", id: "nope" });

  await routes(ctx);

  expect(sent[0]?.status).toBe(409);
});