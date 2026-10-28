// The computer bridge asks here before every action: a person holding the
// computer, a claim that failed, or another thread on the same desktop
// refuse it; the turn's own bearer is the only key; a bot can ask the person
// to take over and withdraw that ask.
import { expect, test } from "vitest";

import type { AutoVmClaimTable } from "../colonie/computer/auto-vm-claims.ts";
import { callRoute } from "../testing/route-context.ts";
import { createInternalComputerControlRoute } from "./internal-computer-control.ts";

const BEARER = "Bearer good";
const owner = { threadId: "t1", generation: "g1" };
function setup(overrides: { kind?: string; held?: boolean; active?: boolean; claim?: boolean; slot?: AutoVmClaimTable extends Map<string, infer S> ? Partial<S> : never; computer?: boolean } = {}) {
  const calls: string[] = [];
  const autoVmClaims: AutoVmClaimTable = new Map();
  if (overrides.slot) autoVmClaims.set("t1", { owner, claim: async () => {}, ...overrides.slot } as never);
  const route = createInternalComputerControlRoute({
    authorize: (header) => header === BEARER ? { botId: "b1", threadId: "t1", generation: "g1", kind: overrides.kind ?? "computer" } : null,
    isActive: () => overrides.active ?? true,
    bot: (id) => id === "b1" ? { id } : undefined,
    snapshot: () => ({ held: overrides.held ?? false, helpReason: null }),
    autoVmClaims,
    turnComputerResources: new Map(overrides.computer ? [["t1", { owner, resource: "computer:vm:shared" }]] : []),
    claimTurnResource: () => overrides.claim ?? true,
    requestHelp: (botId, threadId, reason) => { calls.push(`help ${botId} ${threadId} ${String(reason)}`); return { held: false, helpOpen: true, requestId: "r1" }; },
    expireHelp: (_botId, requestId) => { calls.push(`expire ${String(requestId)}`); return { held: false, helpOpen: false }; },
    announce: (capability) => calls.push(`announce ${capability.generation}`),
    graceMs: 10,
  });
  return { route, calls };
}
const call = async (route: ReturnType<typeof setup>["route"], method = "GET", body: unknown = {}, headers: Record<string, string> = { authorization: BEARER }, path = "/api/internal/computer-control?botId=b1") => {
  const { ctx, sent } = callRoute(path, method, body, headers);
  await route(ctx);
  return sent[0];
};

test("a free computer lets the bot act; a person holding it refuses", async () => {
  expect(await call(setup().route)).toEqual({ status: 200, body: { held: false, helpOpen: false } });
  expect((await call(setup({ held: true }).route))?.body).toEqual({ held: true, helpOpen: false });
});

test("another thread on the same computer, or a failed claim, refuses with the reason", async () => {
  const other = (await call(setup({ computer: true, claim: false }).route))?.body as { held: boolean; blockedReason: string };
  expect(other.held).toBe(true);
  expect(other.blockedReason).toContain("Another thread");
  const failed = (await call(setup({ slot: { failed: true, label: "the Local VM", failure: "not ready" } }).route))?.body as { blockedReason: string };
  expect(failed.blockedReason).toContain("could not claim the Local VM (not ready)");
});

test("only this turn's computer bearer, for its own bot, while the turn runs", async () => {
  expect((await call(setup().route, "GET", {}, {}))?.status).toBe(401);
  expect((await call(setup({ kind: "browser" }).route))?.status).toBe(403);
  expect((await call(setup().route, "GET", {}, { authorization: BEARER }, "/api/internal/computer-control?botId=b2"))?.status).toBe(403);
  expect((await call(setup({ active: false }).route))?.status).toBe(401);
});

test("a bot asks the person to take over, and withdraws an unanswered ask", async () => {
  const { route, calls } = setup();
  expect((await call(route, "POST", { reason: "CAPTCHA on the page" }))?.body).toEqual({ held: false, helpOpen: true, requestId: "r1" });
  expect((await call(route, "DELETE", { requestId: "r1" }))?.body).toEqual({ held: false, helpOpen: false });
  expect((await call(route, "POST", { reason: "x", threadId: "t2" }))?.status).toBe(403);
  expect(calls).toEqual(["help b1 t1 CAPTCHA on the page", "expire r1"]);
});

test("an action let through tells the app the bot is on its computer; a refused one does not", async () => {
  const free = setup();
  await call(free.route);
  expect(free.calls).toEqual(["announce g1"]);
  const held = setup({ held: true });
  await call(held.route);
  expect(held.calls).toEqual([]);
});
