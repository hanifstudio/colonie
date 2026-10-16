import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-colonie.ts";
import type { LiveSettings } from "../shared/wire.ts";

describe("Live credential config authorization", () => {
  it("clears and replaces live credentials as the owner and keeps the settings route free of keys", async () => {
    const fixture = await launchVerificationServer();
    const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const response = await fetch(`${fixture.info.url}${path}`, {
        method,
        headers: { "content-type": "application/json", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
      });
      return { status: response.status, body: await response.json() as {
        code?: string; token?: string; error?: string; scopes?: string[]; live?: LiveSettings;
      } };
    };
    const persistedLive = () => (JSON.parse(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8")) as {
      live?: { key?: string; voice?: string; idleMinutes?: number };
    }).live;
    try {
      expect((await api("PATCH", "/api/config", { live: { key: "fixture-live-owner" } })).status).toBe(200);
      expect((await api("PUT", "/api/config", { live: { key: "fixture-live-admin" } })).status).toBe(200);
      expect(persistedLive()?.key).toBe("fixture-live-admin");
      const readable = await api("GET", "/api/config");
      expect(readable).toMatchObject({ status: 200, body: { live: { configured: true } } });
      expect(JSON.stringify(readable.body)).not.toContain("fixture-live-admin");
      expect(readable.body.live).not.toHaveProperty("key");

      expect((await api("PATCH", "/api/config", { live: { voice: "alloy", idleMinutes: 7 } })).status).toBe(200);
      expect((await api("PATCH", "/api/live/settings", { voice: "ash", idleMinutes: 9 })).status).toBe(200);
      expect(persistedLive()).toMatchObject({ key: "fixture-live-admin", voice: "ash", idleMinutes: 9 });
      // The separate settings route cannot smuggle a key.
      expect((await api("PATCH", "/api/live/settings", { key: "fixture-live-client" })).status).toBe(400);
      expect(persistedLive()?.key).toBe("fixture-live-admin");

      expect((await api("PATCH", "/api/config", { live: { key: "" } })).status).toBe(200);
      expect(persistedLive()?.key).toBe("");
      expect((await api("GET", "/api/config")).body.live?.configured).toBe(false);
      expect((await api("PUT", "/api/config", { live: { key: "fixture-live-restored" } })).status).toBe(200);
      expect(persistedLive()?.key).toBe("fixture-live-restored");
      console.info(JSON.stringify(fixture.info));
    } finally {
      await fixture.close();
    }
  }, 30_000);
});
