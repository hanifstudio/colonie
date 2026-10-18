import { expect, test } from "vitest";
import { callRoute } from "../testing/route-context.ts";
import { PASS } from "./table.ts";
import { cliProbeRoutes } from "./cli-probe.ts";

const run = async (path: string, method = "GET", body: unknown = {}, headers: Record<string, string> = {}) => {
  const { ctx, sent } = callRoute(path, method, body, headers);
  const out = await cliProbeRoutes(ctx);
  return { out, sent };
};

const jsonHeaders = { "content-type": "application/json" };

test("a request that is not its own is left to the next handler", async () => {
  const { out, sent } = await run("/api/health");

  expect(out).toBe(PASS);
  expect(sent).toEqual([]);
});

test("a candidates lookup for a name nobody has comes back empty, not failed", async () => {
  const { sent } = await run("/api/cli-candidates?name=colonie-probe-nobody-has");

  expect(sent).toHaveLength(1);
  expect(sent[0]?.status).toBe(200);
  expect(sent[0]?.body).toEqual({ candidates: [] });
});

test("the probe refuses a form post that could come from another page", async () => {
  const { sent } = await run("/api/cli-test", "POST", { cli: "/bin/echo" }, { "content-type": "text/plain" });

  expect(sent).toEqual([{ status: 415, body: { error: "content-type must be application/json" } }]);
});

test("an empty or multi-line path is refused before anything is executed", async () => {
  const empty = await run("/api/cli-test", "POST", { cli: "   " }, jsonHeaders);
  const multiline = await run("/api/cli-test", "POST", { cli: "/bin/echo\nrm -rf /" }, jsonHeaders);

  expect(empty.sent).toEqual([{ status: 400, body: { error: "cli must be a non-empty path" } }]);
  expect(multiline.sent).toEqual([{ status: 400, body: { error: "cli must be a non-empty path" } }]);
});

test("a binary that is there answers with the version line the UI shows", async () => {
  const { sent } = await run("/api/cli-test", "POST", { cli: process.execPath }, jsonHeaders);

  expect(sent[0]?.status).toBe(200);
  const probe = sent[0]?.body as { ok: boolean; version?: string };
  expect(probe.ok).toBe(true);
  expect(probe.version).toMatch(/^v\d+\./);
});

test("a path that is not there reads as a setup problem, not a crash", async () => {
  const { sent } = await run("/api/cli-test", "POST", { cli: "/nonexistent/colonie-probe" }, jsonHeaders);

  expect(sent[0]?.status).toBe(200);
  const probe = sent[0]?.body as { ok: boolean; message?: string };
  expect(probe.ok).toBe(false);
  expect(probe.message).toMatch(/isn't installed, or isn't on this app's PATH/);
});