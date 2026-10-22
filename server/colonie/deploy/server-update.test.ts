// Updating a Shared workspace's server from the app. The server learns the
// newest published version from the registry, and an admin's Update writes
// a request the server's own host acts on (the set-up script installs that
// watcher); Colonie itself never holds the keys to Docker.
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";

import { createServerUpdate, newestVersion } from "./server-update.ts";

const registry = (tags: string[]) => vi.fn(async (url: string | URL) => {
  const href = String(url);
  if (href.startsWith("https://ghcr.io/token")) return new Response(JSON.stringify({ token: "t" }));
  if (href === "https://ghcr.io/v2/hanifstudio/colonie-workspace/tags/list") return new Response(JSON.stringify({ tags }));
  return new Response("", { status: 404 });
});

test("the newest version is the highest release number, ignoring other tags", () => {
  expect(newestVersion(["latest", "0.2.0", "0.10.1", "0.9.9", "1.0.0-beta.1", "sha-abc"])).toBe("0.10.1");
  expect(newestVersion(["latest"])).toBeNull();
});

test("an admin sees when a newer version is published, and asks for it", async () => {
  const controlDir = mkdtempSync(join(tmpdir(), "colonie-control-"));
  const update = createServerUpdate({ controlDir, version: "0.2.0", image: "ghcr.io/hanifstudio/colonie-workspace:0.2.0", fetch: registry(["0.2.0", "0.2.1", "latest"]) as typeof fetch });
  expect(await update.status()).toEqual({ supported: true, current: "0.2.0", latest: "0.2.1", available: true, requested: null });
  expect(update.request("0.2.1")).toEqual({ requested: "0.2.1" });
  expect(readFileSync(join(controlDir, "update-requested"), "utf8")).toBe("0.2.1\n");
  expect((await update.status()).requested).toBe("0.2.1");
});

test("nothing newer, or a version that was never published, asks for nothing", async () => {
  const controlDir = mkdtempSync(join(tmpdir(), "colonie-control-"));
  const update = createServerUpdate({ controlDir, version: "0.2.1", image: "ghcr.io/hanifstudio/colonie-workspace:0.2.1", fetch: registry(["0.2.0", "0.2.1"]) as typeof fetch });
  expect(await update.status()).toMatchObject({ latest: "0.2.1", available: false });
  expect(() => update.request("9.9.9")).toThrow(/not a published version/);
  expect(() => update.request("0.2.1; reboot")).toThrow();
  expect(existsSync(join(controlDir, "update-requested"))).toBe(false);
});

test("a server set up without the watcher cannot be updated from the app", async () => {
  const update = createServerUpdate({ controlDir: "", version: "0.2.0", image: "colonie-workspace:latest", fetch: registry([]) as typeof fetch });
  expect(await update.status()).toEqual({ supported: false, current: "0.2.0", latest: null, available: false, requested: null });
});
