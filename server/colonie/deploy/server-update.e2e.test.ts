// Updating a Shared workspace's server from the app, on a throwaway server
// with a control folder: admins see the status and may ask; members may not;
// a version that was never published is refused and nothing is written.
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

import { startSharedWorkspace, type SharedWorkspace } from "../../testing/shared-workspace.ts";

const ADA = "ada@x.com";
const BOB = "bob@x.com";
const control = mkdtempSync(join(tmpdir(), "colonie-control-"));
let ws: SharedWorkspace;
let plain: SharedWorkspace;

beforeAll(async () => {
  [ws, plain] = await Promise.all([
    // a local image: no registry is asked, so nothing newer is known
    startSharedWorkspace([{ email: ADA, admin: true }, { email: BOB }], {}, () => ({ COLONIE_CONTROL_DIR: control, COLONIE_IMAGE: "colonie-workspace:latest" })),
    startSharedWorkspace([{ email: ADA, admin: true }]),
  ]);
}, 90_000);
afterAll(async () => { await ws?.stop(); await plain?.stop(); });

test("an admin sees whether the server can be updated from the app", async () => {
  const status = await ws.as(ADA, "/api/server-update");
  expect(status.status).toBe(200);
  expect(status.body).toMatchObject({ supported: true, latest: null, available: false, requested: null });
});

test("a member cannot see or ask for an update", async () => {
  expect((await ws.as(BOB, "/api/server-update")).status).toBe(403);
  expect((await ws.as(BOB, "/api/server-update", { method: "POST", body: { version: "0.2.1" } })).status).toBe(403);
});

test("a version that was never published is refused and nothing is written", async () => {
  const asked = await ws.as(ADA, "/api/server-update", { method: "POST", body: { version: "0.2.1" } });
  expect(asked.status).toBe(400);
  expect(existsSync(join(control, "update-requested"))).toBe(false);
});

test("a server set up without the watcher does not offer updates", async () => {
  expect((await plain.as(ADA, "/api/server-update")).status).toBe(404);
});
