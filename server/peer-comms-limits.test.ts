// Peer comms limits that live on the harness, end to end against a real
// server with the claude-acp adapter on the fake ACP engine.
//
// The room cases this file once held (list_rooms, post_to_room, ask_bot from a
// room turn, room ingress stamps) went with the rooms retirement: their routes
// and tools no longer exist. What stays is direct-conversation behavior that
// shares this harness: a sender may only speak from its own conversation, and a
// delegation is not checkable in the turn that made it.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
/** The scripted ACP engine, spawned exactly as the runtime spawns a real
 * adapter. Colonie is ACP-only, so a fixture engine is claude-acp. */
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const ACP = { cli: process.execPath, args: [FAKE_CLI] };
const ACP_SESSION = { FAKE_ACP_MODES: "default,bypassPermissions", FAKE_ACP_MODELS: "claude-sonnet-5" };
const TEST_CAPABILITY_KEY = "post-to-room-fixture-capability";

let PORT = 0;
let WEBHOOK_PORT = 0;
let BASE = "";
let child: ChildProcess;
let home: string;
let stderr = "";

interface ApiResult {
  status: number;
  body: Record<string, unknown>;
}

const api = async (method: string, path: string, body?: unknown): Promise<ApiResult> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const parsed: unknown = await res.json().catch(() => ({}));
  // SAFETY: the harness answers every /api route with a JSON object; a body
  // that is not one is a bug this cast surfaces as a failed assertion.
  return { status: res.status, body: (parsed ?? {}) as Record<string, unknown> };
};

/** A new turn for this bot on this thread, and the agents bearer it holds. */
const startTurn = async (botId: string, threadId: string): Promise<string> => {
  const minted = await fetch(`${BASE}/api/testing/internal-capability`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-colonie-test-capability": TEST_CAPABILITY_KEY },
    body: JSON.stringify({ botId, threadId, kind: "agents", skillAuthoring: true }),
  });
  return (await minted.json() as { token: string }).token;
};

/** One internal call, made in a new turn of the bot and thread it names. */
const internal = async (method: string, path: string, body?: unknown): Promise<ApiResult> => {
  const url = new URL(path, BASE);
  const claims = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const botId = String(claims.fromBotId ?? claims.botId ?? url.searchParams.get("fromBotId") ?? url.searchParams.get("botId") ?? "");
  const threadId = String(claims.fromThreadId ?? claims.threadId ?? url.searchParams.get("fromThreadId") ?? "");
  return asTurn(await startTurn(botId, threadId), method, path, body);
};

/** One internal call, made with a turn's bearer. */
const asTurn = async (token: string, method: string, path: string, body?: unknown): Promise<ApiResult> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const parsed: unknown = await res.json().catch(() => ({}));
  // SAFETY: same contract as `api` above — internal routes answer JSON too.
  return { status: res.status, body: (parsed ?? {}) as Record<string, unknown> };
};

/** Read a value out of an untyped JSON body without reaching for `any`. */
const field = (body: Record<string, unknown>, ...path: string[]): unknown => {
  let cursor: unknown = body;
  for (const key of path) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
};

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** A bot with a name and a section on the fixture engine. */
const makeBot = async (
  name: string,
  section: string,
  instanceId = "acp",
): Promise<{ id: string; threadId: string }> => {
  const created = await api("POST", "/api/bots");
  const id = str(field(created.body, "bot", "id"));
  const patched = await api("PATCH", `/api/bots/${id}`, {
    name,
    section,
    modelSelection: { instanceId, model: "claude-sonnet-5" },
  });
  expect(patched.status).toBe(200);
  return { id, threadId: str(field(created.body, "bot", "threadId")) };
};

beforeAll(async () => {
  const base = await freePortBlock([0, 1]);
  PORT = base;
  WEBHOOK_PORT = base + 1;
  BASE = `http://127.0.0.1:${PORT}`;
  home = mkdtempSync(join(tmpdir(), "colonie-post-to-room-"));
  mkdirSync(join(home, ".colonie"), { recursive: true });
  writeFileSync(
    join(home, ".colonie", "config.json"),
    JSON.stringify({
      instances: {
        acp: { driver: "claude-acp", displayName: "Fixture Claude", environment: { ...ACP_SESSION }, config: ACP },
      },
    }),
  );
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      COLONIE_PORT: String(PORT),
      COLONIE_WEBHOOK_PORT: String(WEBHOOK_PORT),
      COLONIE_TEST_INTERNAL_CAPABILITY_KEY: TEST_CAPABILITY_KEY,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
    await new Promise((wake) => setTimeout(wake, 150));
  }
}, 60_000);

afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  await removeTempDir(home);
});

describe("peer comms source conversations", () => {
  it("refuses a conversation the sender does not belong to", async () => {
    const outsider = await makeBot("Outsider", "Peer comms");
    const insider = await makeBot("Insider", "Peer comms");
    const helper = await makeBot("Private Helper", "Peer comms");

    const throughPeerTask = await internal("POST", "/api/internal/ask-bot", {
      fromBotId: outsider.id,
      fromThreadId: insider.threadId,
      toBotId: helper.id,
      message: "borrowing your thread",
      depth: 0,
    });
    expect(throughPeerTask.status).toBe(403);
    expect(str(throughPeerTask.body.error)).toContain("does not belong to sender");
  }, 40_000);
});

// A warm engine keeps its proxies, and their bearer, from one turn to the
// next; what a turn may still do is counted on the harness, per turn.
describe("limits counted per turn on a bearer that outlives the turn", () => {
  it("refuses to check a delegation in the turn that made it, and answers in the next", async () => {
    const from = await makeBot("Turn Delegator", "Turn delegations");
    const to = await makeBot("Turn Delegate", "Turn delegations");
    const token = await startTurn(from.id, from.threadId);
    const delegated = await asTurn(token, "POST", "/api/internal/delegate-bot", {
      fromBotId: from.id, fromThreadId: from.threadId, toBotId: to.id, message: "Write the summary.", depth: 0,
    });
    expect(delegated.status, JSON.stringify(delegated.body)).toBe(200);
    const taskId = str(delegated.body.taskId);
    expect(taskId).not.toBe("");
    const early = await asTurn(token, "GET", `/api/internal/delegations/${taskId}`);
    expect(early.status).toBe(409);
    expect(str(early.body.error)).toContain(`Task ${taskId} was delegated during this turn`);

    expect(await startTurn(from.id, from.threadId)).toBe(token);
    const later = await asTurn(token, "GET", `/api/internal/delegations/${taskId}`);
    expect(later.status, JSON.stringify(later.body)).toBe(200);
  }, 40_000);
});
