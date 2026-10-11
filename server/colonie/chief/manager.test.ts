import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ColonieChief, type ChiefDeps } from "./manager.ts";
import type { ChiefAssignment, ChiefBot } from "../../../shared/colonie-chief.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "colonie-chief-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function bot(id: string, extra: Partial<ChiefBot> = {}): ChiefBot {
  return { id, name: id, title: `${id} title`, description: "", modelSelection: { instanceId: "inst", model: "model" }, ...extra };
}

interface Fixture {
  deps: ChiefDeps;
  chief: ColonieChief;
  registry: Map<string, ChiefBot>;
  setChief(id: string | null): void;
  setRun(fn: ChiefDeps["runAssignment"]): void;
  close(): Promise<void>;
}

async function makeFixture(): Promise<Fixture> {
  const registry = new Map<string, ChiefBot>([
    ["chief", bot("chief", { chiefOfStaff: true })],
    ["worker", bot("worker")],
  ]);
  const owned = new Set(["chief:thread-1", "worker:thread-2", "chief:thread-3"]);
  const turns = new Map([["chief:thread-1", "turn-1"], ["worker:thread-2", "turn-2"], ["chief:thread-3", "turn-3"]]);
  let role: string | null = "chief";
  let runBehavior: ChiefDeps["runAssignment"] = async () => "child result";
  const deps: ChiefDeps = {
    origin: "",
    dataDir: dir,
    bots: () => [...registry.values()],
    bot: (id) => registry.get(id),
    chiefId: () => role,
    owns: (botId, threadId) => owned.has(`${botId}:${threadId}`),
    currentTurn: (botId, threadId) => turns.get(`${botId}:${threadId}`) ?? null,
    busy: () => false,
    setChief: (id) => {
      role = id;
    },
    createBot: async (input) => {
      const created = bot(`bot-${registry.size}`, { name: input.name, title: input.title ?? "", description: input.description ?? "" });
      registry.set(created.id, created);
      return created;
    },
    updateBot: async (id, patch) => {
      const next = { ...registry.get(id)!, ...patch };
      registry.set(id, next);
      return next;
    },
    deleteBot: async (id) => {
      registry.delete(id);
    },
    createAssignmentThread: (job) => `task-${job.id}`,
    runAssignment: (job, signal) => runBehavior(job, signal),
    skills: {
      list: (botId) => ({ botId, skills: ["guide"] }),
      readEnabled: (_botId, name) => (name === "guide" ? { text: "GUIDE TEXT", sha256: "sha-guide" } : null),
      save: () => ({ saved: true }),
      setEnabled: () => ({ enabled: true }),
      remove: () => ({ removed: true }),
    },
  };
  const chief = new ColonieChief(deps);
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    await chief.handle(req, res, body ? JSON.parse(body) : null);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  deps.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    deps,
    chief,
    registry,
    setChief: (id) => {
      role = id;
    },
    setRun: (fn) => {
      runBehavior = fn;
    },
    close: async () => {
      chief.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function headersFor(mount: NonNullable<ReturnType<ColonieChief["mount"]>>): Record<string, string> {
  const remote = mount.servers[0]!;
  if (!("type" in remote) || remote.type !== "http") throw new Error("fixture requires HTTP");
  return Object.fromEntries(remote.headers.map(({ name, value }) => [name, value]));
}

async function rpc(origin: string, headers: Record<string, string>, method: string, params: unknown = {}, id = 1) {
  const response = await fetch(`${origin}/api/internal/colonie-workspace-mcp`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: AbortSignal.timeout(10_000) });
  return { status: response.status, body: (await response.json()) as any };
}

describe("ColonieChief loopback MCP", () => {
  it("rejects a bad bearer, a browser Origin, and unsupported methods", async () => {
    const f = await makeFixture();
    try {
      const mount = f.chief.mount("chief", "thread-1", "inst")!;
      const headers = headersFor(mount);
      const bad = await rpc(f.deps.origin, { ...headers, Authorization: `Bearer ${"0".repeat(64)}` }, "tools/list");
      expect(bad.status).toBe(401);

      const browser = await fetch(`${f.deps.origin}/api/internal/colonie-workspace-mcp`, { method: "POST", headers: { ...headers, "content-type": "application/json", origin: "http://localhost" }, body: "{}" });
      expect(browser.status).toBe(401);

      const get = await fetch(`${f.deps.origin}/api/internal/colonie-workspace-mcp`, { headers });
      expect(get.status).toBe(405);
    } finally {
      await f.close();
    }
  });

  it("needs an active turn before any tool runs", async () => {
    const f = await makeFixture();
    try {
      const mount = f.chief.mount("chief", "thread-1", "inst")!;
      const headers = headersFor(mount);
      const list = await rpc(f.deps.origin, headers, "tools/list");
      expect(list.body.result.tools.map((tool: { name: string }) => tool.name)).toContain("ask_bot");
      const call = await rpc(f.deps.origin, headers, "tools/call", { name: "list_bots", arguments: {} });
      expect(call.body.result.isError).toBe(true);
      mount.activate();
      expect((await rpc(f.deps.origin, headers, "tools/call", { name: "list_bots", arguments: {} })).body.result.content[0].text).toContain("worker");
      mount.deactivate();
      expect((await rpc(f.deps.origin, headers, "tools/call", { name: "list_bots", arguments: {} }, 2)).body.result.isError).toBe(true);
    } finally {
      await f.close();
    }
  });

  it("lets the Chief create, read, update and delete other bots idempotently", async () => {
    const f = await makeFixture();
    try {
      const mount = f.chief.mount("chief", "thread-1", "inst")!;
      const headers = headersFor(mount);
      mount.activate();

      const created = await rpc(f.deps.origin, headers, "tools/call", { name: "create_bot", arguments: { name: "New Bot", requestId: "req-create" } });
      expect(created.body.result.isError).toBeUndefined();
      const createdId = JSON.parse(created.body.result.content[0].text).id;

      const replay = await rpc(f.deps.origin, headers, "tools/call", { name: "create_bot", arguments: { name: "New Bot", requestId: "req-create" } }, 2);
      expect(JSON.parse(replay.body.result.content[0].text).id).toBe(createdId);
      expect([...f.registry.keys()].filter((id) => id.startsWith("bot-"))).toHaveLength(1);

      const mismatch = await rpc(f.deps.origin, headers, "tools/call", { name: "create_bot", arguments: { name: "Different", requestId: "req-create" } }, 3);
      expect(mismatch.body.result.isError).toBe(true);
      expect(mismatch.body.result.content[0].text).toContain("different operation");

      const updated = await rpc(f.deps.origin, headers, "tools/call", { name: "update_bot", arguments: { botId: createdId, title: "Changed", requestId: "req-update" } }, 4);
      expect(updated.body.result.content[0].text).toContain("Changed");

      const del = await rpc(f.deps.origin, headers, "tools/call", { name: "delete_bot", arguments: { botId: createdId, requestId: "req-delete" } }, 5);
      expect(del.body.result.content[0].text).toContain(createdId);
      expect(f.registry.has(createdId)).toBe(false);

      const selfDelete = await rpc(f.deps.origin, headers, "tools/call", { name: "delete_bot", arguments: { botId: "chief", requestId: "req-self" } }, 6);
      expect(selfDelete.body.result.isError).toBe(true);
      expect(f.registry.has("chief")).toBe(true);

      expect(mount.calls().some((call) => call.tool === "delete_bot" && call.status === "completed")).toBe(true);
    } finally {
      await f.close();
    }
  });

  it("gives an ordinary bot only its scoped read_skill and refuses unselected or changed content", async () => {
    const f = await makeFixture();
    try {
      expect(f.chief.mount("worker", "thread-2", "inst")).toBeNull();

      const mount = f.chief.mount("worker", "thread-2", "inst", "rev", { guide: "sha-guide" })!;
      const headers = headersFor(mount);
      mount.activate();
      const list = await rpc(f.deps.origin, headers, "tools/list");
      const names = list.body.result.tools.map((tool: { name: string }) => tool.name);
      expect(names).toEqual(["read_skill", "list_my_skills"]);
      expect(names).not.toContain("create_bot");

      const manage = await rpc(f.deps.origin, headers, "tools/call", { name: "create_bot", arguments: { name: "x", requestId: "req-1" } }, 2);
      expect(manage.body.result.isError).toBe(true);

      const read = await rpc(f.deps.origin, headers, "tools/call", { name: "read_skill", arguments: { name: "guide" } }, 3);
      expect(read.body.result.content[0].text).toBe("GUIDE TEXT");

      const unselected = await rpc(f.deps.origin, headers, "tools/call", { name: "read_skill", arguments: { name: "other" } }, 4);
      expect(unselected.body.result.isError).toBe(true);

      const changed = f.chief.mount("worker", "thread-2", "inst-2", "rev", { guide: "sha-changed" })!;
      const changedHeaders = headersFor(changed);
      changed.activate();
      const stale = await rpc(f.deps.origin, changedHeaders, "tools/call", { name: "read_skill", arguments: { name: "guide" } }, 5);
      expect(stale.body.result.isError).toBe(true);
    } finally {
      await f.close();
    }
  });

  it("refuses management calls as soon as the Chief role moves", async () => {
    const f = await makeFixture();
    try {
      const mount = f.chief.mount("chief", "thread-1", "inst")!;
      const headers = headersFor(mount);
      mount.activate();
      expect((await rpc(f.deps.origin, headers, "tools/call", { name: "list_bots", arguments: {} })).body.result.isError).toBeUndefined();

      f.setChief("worker");
      const after = await rpc(f.deps.origin, headers, "tools/call", { name: "list_bots", arguments: {} }, 2);
      expect(after.status).toBe(401);
    } finally {
      await f.close();
    }
  });

  it("runs a delegated child and returns its actual result, never a success claim on failure", async () => {
    const f = await makeFixture();
    try {
      const mount = f.chief.mount("chief", "thread-1", "inst")!;
      const headers = headersFor(mount);
      mount.activate();

      const ok = await rpc(f.deps.origin, headers, "tools/call", { name: "ask_bot", arguments: { targetBotId: "worker", message: "summarize", requestId: "req-ask-1" } });
      expect(ok.body.result.content[0].text).toContain("child result");
      const done = f.chief.view("thread-1").assignments.find((assignment) => assignment.status === "completed");
      expect(done?.result).toContain("child result");
      expect(done?.targetThreadId).toBeTruthy();

      const self = await rpc(f.deps.origin, headers, "tools/call", { name: "ask_bot", arguments: { targetBotId: "chief", message: "x", requestId: "req-ask-2" } }, 2);
      expect(self.body.result.isError).toBe(true);
      expect(self.body.result.content[0].text).toContain("cannot ask itself");

      f.setRun(async () => {
        throw new Error("provider exploded");
      });
      const failed = await rpc(f.deps.origin, headers, "tools/call", { name: "ask_bot", arguments: { targetBotId: "worker", message: "fail", requestId: "req-ask-3" } }, 3);
      expect(failed.body.result.isError).toBe(true);
      expect(failed.body.result.content[0].text).toContain("provider exploded");
      const failedJob = f.chief.view("thread-1").assignments.find((assignment) => assignment.status === "failed");
      expect(failedJob?.result).toBeUndefined();

      const replay = await rpc(f.deps.origin, headers, "tools/call", { name: "ask_bot", arguments: { targetBotId: "worker", message: "fail", requestId: "req-ask-3" } }, 4);
      expect(replay.body.result.isError).toBe(true);
      expect(replay.body.result.content[0].text).toContain("provider exploded");
    } finally {
      await f.close();
    }
  });

  it("cancels only the source conversation's own children", async () => {
    const f = await makeFixture();
    try {
      let hang = true;
      f.setRun(
        (_job, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
            if (!hang) reject(new Error("not hanging"));
          }),
      );
      const first = f.chief.mount("chief", "thread-1", "a")!;
      const second = f.chief.mount("chief", "thread-3", "b")!;
      const firstHeaders = headersFor(first);
      const secondHeaders = headersFor(second);
      first.activate();
      second.activate();

      const pendingFirst = rpc(f.deps.origin, firstHeaders, "tools/call", { name: "ask_bot", arguments: { targetBotId: "worker", message: "one", requestId: "req-a" } });
      const pendingSecond = rpc(f.deps.origin, secondHeaders, "tools/call", { name: "ask_bot", arguments: { targetBotId: "worker", message: "two", requestId: "req-b" } });
      await new Promise((resolve) => setTimeout(resolve, 20));

      f.chief.cancelSource("thread-1");
      const firstResult = await pendingFirst;
      expect(firstResult.body.result.isError).toBe(true);
      expect(f.chief.view("thread-1").assignments[0]?.status).toBe("cancelled");
      expect(f.chief.view("thread-3").assignments[0]?.status).toBe("running");

      f.chief.cancelSource("thread-3");
      await pendingSecond;
      expect(f.chief.view("thread-3").assignments[0]?.status).toBe("cancelled");
      hang = false;
    } finally {
      await f.close();
    }
  });

  it("shows interrupted ownership after restart and never treats it as current", async () => {
    const f = await makeFixture();
    try {
      const job: ChiefAssignment = {
        id: "a-restart",
        chiefBotId: "chief",
        sourceThreadId: "thread-1",
        sourceTurnId: "turn-1",
        targetBotId: "worker",
        targetThreadId: "task-restart",
        message: "still going",
        status: "running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      f.chief.store.createAssignment(job);

      const restarted = new ColonieChief(f.deps, dir);
      const view = restarted.view("thread-1");
      expect(view.assignments[0]?.status).toBe("interrupted");
      expect(restarted.isAssignmentCurrent("a-restart", "worker", "task-restart")).toBe(false);
    } finally {
      await f.close();
    }
  });
});