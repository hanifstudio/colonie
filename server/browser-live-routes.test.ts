import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, runControlColonie, type VerificationServer } from "../scripts/control-colonie.ts";

let fixture: VerificationServer;
let botId: string;
const remote = { "x-forwarded-for": "198.51.100.18", "x-forwarded-proto": "https" };

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${fixture.info.url}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, body: await response.json() as any, headers: response.headers };
}

beforeAll(async () => {
  fixture = await launchVerificationServer();
  const env = { COLONIE_URL: fixture.info.url };
  expect((await runControlColonie(["doctor"], { env }) as any).ok).toBe(true);
  const created = await runControlColonie(["new-bot", "--name", "Browser profile fixture"], { env }) as any;
  botId = created.bot.id;
}, 30_000);

afterAll(async () => { await fixture?.close(); });

describe("live browser route authorization", () => {
  it.each([["GET", "live"], ["POST", "action"]])("keeps %s %s owner-only", async (method, suffix) => {
    const path = `/api/bots/${botId}/browser/${suffix}`;
    const body = method === "POST" ? { viewerId: "forged", type: "take" } : undefined;
    expect((await call(method, path, body, remote)).status).toBe(403);
    const crossOrigin = await call(method, path, body, { origin: "https://attacker.invalid" });
    expect(crossOrigin.status).toBe(403);
    expect(crossOrigin.body.error).toContain("cross-origin");
    // The authenticated owner gets past authorization to the feature gates;
    // no native browser is installed or launched in this fixture. The built-in
    // browser is on by default, so the first gate met is the missing engine…
    expect((await call("PATCH", "/api/config", { features: { browser: true } })).status).toBe(200);
    const onByDefault = await call(method, path, body);
    expect(onByDefault.status).toBe(503);
    expect(onByDefault.body.error).toContain("Install the browser engine");
    // …and a browser the person switched off still refuses before the engine.
    expect((await call("PATCH", "/api/config", { features: { browser: false } })).status).toBe(200);
    const owner = await call(method, path, body);
    expect(owner.status).toBe(409);
    expect(owner.body.error).toContain("Enable this bot's browser");
  });
});

describe("profile list compare-and-swap", () => {
  it("rejects stale deletion without losing profiles, assignments, or a later rename", async () => {
    const original = [{ id: "work", name: "Work" }, { id: "personal", name: "Personal" }];
    const created = await call("PATCH", "/api/config", { browserProfiles: original, expectedBrowserProfiles: [] });
    expect(created.status).toBe(200);
    expect(created.body.browserProfiles).toEqual(original);
    expect((await call("PATCH", `/api/bots/${botId}`, { browserProfile: "work" })).status).toBe(200);

    const renamed = [{ id: "work", name: "Renamed work" }, original[1]];
    const saved = await call("PATCH", "/api/config", { browserProfiles: renamed, expectedBrowserProfiles: original });
    expect(saved.status).toBe(200);
    const stale = await call("PATCH", "/api/config", { browserProfiles: [], expectedBrowserProfiles: original });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toContain("another window");
    expect((await call("GET", "/api/config")).body.browserProfiles).toEqual(renamed);
    const currentBot = (await call("GET", "/api/bots")).body.bots.find((bot: any) => bot.id === botId);
    expect(currentBot.browserProfile).toBe("work");

    // A reviewed, current deletion clears assignments on the server, not by
    // optimistic renderer edits. The fixture has no engine or saved logins.
    const removed = await call("PATCH", "/api/config", { browserProfiles: [original[1]], expectedBrowserProfiles: renamed });
    expect(removed.status).toBe(200);
    expect(removed.body.browserProfiles).toEqual([original[1]]);
    const afterRemoval = (await call("GET", "/api/bots")).body.bots.find((bot: any) => bot.id === botId);
    expect(afterRemoval.browserProfile).toBeUndefined();
  });
});
