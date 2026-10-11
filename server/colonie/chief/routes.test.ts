import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ColonieChief, type ChiefDeps } from "./manager.ts";
import { createChiefRoutes } from "./routes.ts";
import { PASS, type RouteContext } from "../../routes/table.ts";
import type { ChiefBot } from "../../../shared/colonie-chief.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "colonie-chief-routes-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function bot(id: string): ChiefBot {
  return { id, name: id, title: "", description: "", modelSelection: { instanceId: "i", model: "m" } };
}

function setup(options: { busy?: boolean; owns?: boolean; role?: string | null } = {}) {
  const registry = new Map<string, ChiefBot>([["chief", bot("chief")], ["worker", bot("worker")]]);
  const setChief = vi.fn((id: string) => void id);
  const deps: ChiefDeps = {
    origin: "http://127.0.0.1:1",
    dataDir: dir,
    bots: () => [...registry.values()],
    bot: (id) => registry.get(id),
    chiefId: () => (options.role === undefined ? "chief" : options.role),
    owns: () => options.owns ?? true,
    currentTurn: () => null,
    busy: () => options.busy ?? false,
    setChief,
    createBot: async () => bot("new"),
    updateBot: async (id) => bot(id),
    deleteBot: async () => {},
    createAssignmentThread: () => "task",
    runAssignment: async () => "",
    skills: { list: () => ({}), readEnabled: () => null, save: () => ({}), setEnabled: () => ({}), remove: () => ({}) },
  };
  const chief = new ColonieChief(deps, dir);
  const route = createChiefRoutes({ chief, exists: (id) => registry.has(id), changed: vi.fn() });
  return { route, chief, registry, setChief };
}

interface CtxResult {
  status: number;
  payload: unknown;
}
function harness(options: { method: string; path: string; body?: unknown; auth?: unknown }) {
  const out: CtxResult = { status: 0, payload: undefined };
  const url = new URL(`http://localhost${options.path}`);
  const ctx = {
    req: {} as RouteContext["req"],
    res: {} as RouteContext["res"],
    url,
    path: url.pathname,
    method: options.method,
    auth: options.auth ?? { kind: "loopback", trust: "owner" },
    json: (_res: unknown, status: number, payload: unknown) => {
      out.status = status;
      out.payload = payload;
    },
    readBody: async () => options.body,
  } as unknown as RouteContext;
  return { ctx, out };
}

describe("createChiefRoutes", () => {
  it("declines unrelated paths and refuses a service caller", async () => {
    const { route } = setup();
    expect(await route(harness({ method: "GET", path: "/api/other" }).ctx)).toBe(PASS);
    const service = harness({ method: "GET", path: "/api/colonie/chief", auth: { kind: "loopback", trust: "service" } });
    await route(service.ctx);
    expect(service.out.status).toBe(403);
  });

  it("reads the view and validates a supplied source thread", async () => {
    const { route } = setup();
    const ok = harness({ method: "GET", path: "/api/colonie/chief?threadId=thread-1" });
    await route(ok.ctx);
    expect(ok.out.status).toBe(200);
    expect((ok.out.payload as { chief: ChiefBot | null }).chief?.id).toBe("chief");

    const foreign = setup({ owns: false });
    const denied = harness({ method: "GET", path: "/api/colonie/chief?threadId=someone-else" });
    await foreign.route(denied.ctx);
    expect(denied.out.status).toBe(403);
  });

  it("transfers the role with optimistic concurrency", async () => {
    const { route, setChief } = setup();
    const stale = harness({ method: "PUT", path: "/api/colonie/chief", body: { botId: "worker", expectedRevision: "other" } });
    await route(stale.ctx);
    expect(stale.out.status).toBe(409);
    expect(setChief).not.toHaveBeenCalled();

    const ok = harness({ method: "PUT", path: "/api/colonie/chief", body: { botId: "worker", expectedRevision: "chief" } });
    await route(ok.ctx);
    expect(ok.out.status).toBe(200);
    expect(setChief).toHaveBeenCalledWith("worker", "chief");
  });

  it("404s an unknown target and 409s while the Chief is busy", async () => {
    const unknown = setup();
    const notFound = harness({ method: "PUT", path: "/api/colonie/chief", body: { botId: "ghost", expectedRevision: "chief" } });
    await unknown.route(notFound.ctx);
    expect(notFound.out.status).toBe(404);

    const busy = setup({ busy: true });
    const refused = harness({ method: "PUT", path: "/api/colonie/chief", body: { botId: "worker", expectedRevision: "chief" } });
    await busy.route(refused.ctx);
    expect(refused.out.status).toBe(409);
  });

  it("400s a malformed body", async () => {
    const { route } = setup();
    const bad = harness({ method: "PUT", path: "/api/colonie/chief", body: { botId: "" } });
    await route(bad.ctx);
    expect(bad.out.status).toBe(400);
  });
});