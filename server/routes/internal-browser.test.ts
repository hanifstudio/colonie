// The built-in browser's calls are honoured only for the turn's own browser
// bearer, while the bot still browses in the same session, and a call claims
// that browser for the turn.
import { expect, test } from "vitest";

import { callRoute } from "../testing/route-context.ts";
import { createInternalBrowserRoute } from "./internal-browser.ts";

const BEARER = "Bearer good";
function setup(overrides: { kind?: string; browser?: boolean; session?: string; active?: boolean; claim?: boolean; result?: unknown } = {}) {
  const calls: string[] = [];
  const capability = { botId: "b1", threadId: "t1", generation: "g1", kind: overrides.kind ?? "browser", browserSession: "s1" };
  const route = createInternalBrowserRoute({
    authorize: (header) => header === BEARER ? capability : null,
    isActive: () => overrides.active ?? true,
    bot: (id) => id === "b1" ? { id, browser: overrides.browser ?? true } : undefined,
    browserEnabled: () => true,
    browserIntegration: async () => ({ session: overrides.session ?? "s1", spec: { command: "agent-browser", args: [], env: {} } }),
    currentBrowserSession: () => overrides.session ?? "s1",
    claimTurnResource: (_owner, resource) => { calls.push(`claim ${resource}`); return overrides.claim ?? true; },
    runtime: { agentRpc: async (session, _spec, method, _params, before) => { before?.(); calls.push(`${method} ${session}`); return overrides.result ?? { ok: true }; } },
    announce: (owner) => calls.push(`announce ${owner.generation}`),
  });
  return { route, calls };
}
const call = async (route: ReturnType<typeof setup>["route"], headers: Record<string, string> = { authorization: BEARER }, body: unknown = { method: "tools/call", params: {} }) => {
  const { ctx, sent } = callRoute("/api/internal/browser/mcp", "POST", body, headers);
  try { await route(ctx); } catch (error) { return { status: (error as { status?: number }).status, body: (error as Error).message }; }
  return sent[0];
};

test("a call reaches the bot's own browser session and claims it for the turn", async () => {
  const { route, calls } = setup();
  expect(await call(route)).toEqual({ status: 200, body: { result: { ok: true } } });
  expect(calls).toEqual(["claim browser:s1", "announce g1", "tools/call s1"]);
});

test("listing the tools does not announce browser use", async () => {
  const { route, calls } = setup();
  await call(route, { authorization: BEARER }, { method: "tools/list" });
  expect(calls).toEqual(["tools/list s1"]);
});

test("no bearer, another integration's bearer, or an ended turn is refused", async () => {
  expect((await call(setup().route, {}))?.status).toBe(401);
  expect((await call(setup({ kind: "agents" }).route))?.status).toBe(403);
  expect((await call(setup({ active: false }).route))?.status).toBe(401);
});

test("a bot whose browser was turned off, or whose session changed, is refused", async () => {
  expect((await call(setup({ browser: false }).route))?.status).toBe(403);
  expect((await call(setup({ session: "s2" }).route))?.status).toBe(409);
});

test("another thread holding the same browser refuses the call", async () => {
  const { route, calls } = setup({ claim: false });
  expect((await call(route))?.status).toBe(409);
  expect(calls).toEqual(["claim browser:s1"]);
});

test("the fetch-style read tool is neither listed nor callable", async () => {
  const listed = await call(setup({ result: { tools: [{ name: "agent_browser_open" }, { name: "agent_browser_read" }] } }).route, { authorization: BEARER }, { method: "tools/list" });
  expect(listed).toEqual({ status: 200, body: { result: { tools: [{ name: "agent_browser_open" }] } } });
  const { route, calls } = setup();
  expect((await call(route, { authorization: BEARER }, { method: "tools/call", params: { name: "agent_browser_read" } }))?.status).toBe(404);
  expect(calls).toEqual([]);
});

test("a page showing a CAPTCHA tells the bot to hand it to the person", async () => {
  const captcha = { content: [{ type: "text", text: "- iframe \"Widget containing a Cloudflare security challenge\" src=https://challenges.cloudflare.com/x" }] };
  const answered = (await call(setup({ result: captcha }).route)) as { body: { result: { content: Array<{ text: string }> } } };
  expect(answered.body.result.content.at(-1)?.text).toContain("request_sign_in");
  const plain = { content: [{ type: "text", text: "Jakarta to Cirebon, Rp 125.000" }] };
  expect(await call(setup({ result: plain }).route)).toEqual({ status: 200, body: { result: plain } });
});

test("only tool listing and calls pass through", async () => {
  expect((await call(setup().route, { authorization: BEARER }, { method: "resources/list" }))?.status).toBe(400);
});
