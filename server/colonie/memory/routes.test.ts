import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ColonieMemoryStore } from "./store.ts";
import { ColonieMemoryService } from "./service.ts";
import { createColonieMemoryRoutes } from "./routes.ts";
import { PASS, type RouteContext } from "../../routes/table.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "colonie-routes-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface CtxResult {
  status: number;
  payload: unknown;
}

function harness(options: {
  method: string;
  path: string;
  body?: unknown;
  auth?: unknown;
  exists?: (botId: string) => boolean;
  onReadBody?: () => void;
}) {
  const out: CtxResult = { status: 0, payload: undefined };
  const url = new URL(`http://localhost${options.path}`);
  const path = url.pathname;
  const ctx = {
    req: {} as RouteContext["req"],
    res: {} as RouteContext["res"],
    url,
    path,
    method: options.method,
    auth: options.auth ?? { kind: "loopback", trust: "owner" },
    json: (_res: unknown, status: number, payload: unknown) => {
      out.status = status;
      out.payload = payload;
    },
    readBody: async () => {
      options.onReadBody?.();
      return options.body;
    },
  } as unknown as RouteContext;
  return { ctx, out };
}

function setup(exists: (botId: string) => boolean = () => true) {
  const store = new ColonieMemoryStore(dir);
  const setBotMemoryEnabled = vi.fn();
  const service = new ColonieMemoryService(store, { bot: () => ({ id: "bot-1", memoryEnabled: true }), owns: () => true, analyze: async () => "[]" });
  const route = createColonieMemoryRoutes({ service, exists, setBotMemoryEnabled });
  return { store, service, setBotMemoryEnabled, route };
}

describe("createColonieMemoryRoutes", () => {
  it("returns PASS for unrelated requests", async () => {
    const { route } = setup();
    const { ctx } = harness({ method: "GET", path: "/api/other" });
    expect(await route(ctx)).toBe(PASS);
  });

  it("403s a session-less service caller", async () => {
    const { route } = setup();
    const { ctx, out } = harness({ method: "GET", path: "/api/bots/bot-1/colonie-memory", auth: { kind: "loopback", trust: "service" } });
    await route(ctx);
    expect(out.status).toBe(403);
  });

  it("404s an unknown bot", async () => {
    const { route } = setup(() => false);
    const { ctx, out } = harness({ method: "GET", path: "/api/bots/bot-1/colonie-memory" });
    await route(ctx);
    expect(out.status).toBe(404);
  });

  it("reads a view and toggles the base bot switch on a bot-scope preference change", async () => {
    const { route, setBotMemoryEnabled } = setup();
    const read = harness({ method: "GET", path: "/api/bots/bot-1/colonie-memory" });
    await route(read.ctx);
    expect(read.out.status).toBe(200);
    const revision = (read.out.payload as { revision: string }).revision;

    const patch = harness({
      method: "PATCH",
      path: "/api/bots/bot-1/colonie-memory/preferences",
      body: { scope: "bot", preferences: { enabled: false, automatic: true }, expectedRevision: revision },
    });
    await route(patch.ctx);
    expect(patch.out.status).toBe(200);
    expect((patch.out.payload as { bot: { enabled: boolean } }).bot.enabled).toBe(false);
    expect(setBotMemoryEnabled).toHaveBeenCalledWith("bot-1", false);
  });

  it("creates, edits and forgets an entry with a fresh view each time", async () => {
    const { route } = setup();
    const create = harness({
      method: "POST",
      path: "/api/bots/bot-1/colonie-memory/entries",
      body: { entry: { scope: "bot", kind: "fact", text: "Runs on Node." }, expectedRevision: "1" },
    });
    await route(create.ctx);
    expect(create.out.status).toBe(200);
    const view = create.out.payload as { revision: string; entries: Array<{ id: string }> };
    const id = view.entries[0]!.id;

    const edit = harness({ method: "PATCH", path: `/api/bots/bot-1/colonie-memory/entries/${id}`, body: { text: "Runs on Node 24.", expectedRevision: view.revision } });
    await route(edit.ctx);
    expect(edit.out.status).toBe(200);
    expect((edit.out.payload as { entries: Array<{ text: string }> }).entries[0]!.text).toBe("Runs on Node 24.");

    const revision = (edit.out.payload as { revision: string }).revision;
    const remove = harness({ method: "DELETE", path: `/api/bots/bot-1/colonie-memory/entries/${id}?expectedRevision=${encodeURIComponent(revision)}` });
    await route(remove.ctx);
    expect(remove.out.status).toBe(200);
    expect((remove.out.payload as { entries: unknown[] }).entries).toHaveLength(0);
  });

  it("rejects a stale revision with 409", async () => {
    const { route } = setup();
    const patch = harness({
      method: "PATCH",
      path: "/api/bots/bot-1/colonie-memory/preferences",
      body: { scope: "bot", preferences: { enabled: false, automatic: true }, expectedRevision: "999" },
    });
    await route(patch.ctx);
    expect(patch.out.status).toBe(409);
  });

  it("rechecks the bot at the write boundary after reading the body", async () => {
    let present = true;
    const { route } = setup(() => present);
    const create = harness({
      method: "POST",
      path: "/api/bots/bot-1/colonie-memory/entries",
      body: { entry: { scope: "bot", kind: "fact", text: "Runs on Node." }, expectedRevision: "1" },
      onReadBody: () => {
        present = false;
      },
    });
    await route(create.ctx);
    expect(create.out.status).toBe(404);
  });

  it("clears a scope and requires expectedRevision on delete", async () => {
    const { route } = setup();
    const noRevision = harness({ method: "DELETE", path: "/api/bots/bot-1/colonie-memory/entries/missing" });
    await route(noRevision.ctx);
    expect(noRevision.out.status).toBe(400);

    const clear = harness({ method: "POST", path: "/api/bots/bot-1/colonie-memory/clear", body: { scope: "bot", expectedRevision: "1" } });
    await route(clear.ctx);
    expect(clear.out.status).toBe(200);
  });
});