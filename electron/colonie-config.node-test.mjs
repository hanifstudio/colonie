// These three helpers decide where the app keeps its own folder (the workspace
// list) and where a workspace keeps its data. The launcher reads the first
// without Electron, so the mirror has to answer the way Electron answers.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { colonieAppData, colonieDataDir, colonieHome, colonieUserData, developmentData, initializeColonieData } from "./colonie-config.mjs";

const HOME = path.join(path.sep, "home", "you");

test("a workspace's data directory is the historical one unless one is chosen", () => {
  assert.equal(colonieDataDir(HOME, {}), path.join(HOME, ".colonie"));
  assert.equal(colonieDataDir(HOME, { COLONIE_DATA_DIR: path.join(path.sep, "rig") }), path.join(path.sep, "rig"));
});

test("the app's own folder is called Colonie, and an explicit choice wins", () => {
  assert.equal(colonieUserData(path.join(HOME, "Application Support"), {}), path.join(HOME, "Application Support", "Colonie"));
  assert.equal(colonieUserData(path.join(HOME, "Application Support"), { COLONIE_USER_DATA: "/elsewhere" }), "/elsewhere");
});

test("the mirrored application-data folder matches what Electron reports per platform", () => {
  assert.equal(colonieAppData(HOME, {}, "darwin"), path.join(HOME, "Library", "Application Support"));
  assert.equal(colonieAppData(HOME, { APPDATA: "C:\\Users\\you\\AppData\\Roaming" }, "win32"), "C:\\Users\\you\\AppData\\Roaming");
  assert.equal(colonieAppData(HOME, {}, "win32"), path.join(HOME, "AppData", "Roaming"));
  assert.equal(colonieAppData(HOME, {}, "linux"), path.join(HOME, ".config"));
  assert.equal(colonieAppData(HOME, { XDG_CONFIG_HOME: "/xdg" }, "linux"), "/xdg");
});

test("the launcher and the app resolve the same workspace list folder on this platform", () => {
  // What the launcher computes for itself must be what electron/colonie.mjs
  // hands Electron, or a switch made in the app would land somewhere else.
  const userData = colonieUserData(colonieAppData(HOME, {}, "darwin"));
  assert.equal(userData, path.join(HOME, "Library", "Application Support", "Colonie"));
});

test("a development run gets its own data unless real data is asked for", () => {
  const dev = path.join(HOME, ".colonie-dev-data");
  assert.deepEqual(developmentData(HOME, ["start.ts"], {}), { COLONIE_HOME: dev, COLONIE_USER_DATA: path.join(dev, "app") });
  assert.deepEqual(developmentData(HOME, ["start.ts", "--real-data"], {}), {});
  assert.deepEqual(developmentData(HOME, ["start.ts"], { COLONIE_DATA_DIR: "/rig" }), {});
  assert.deepEqual(developmentData(HOME, ["start.ts"], { COLONIE_HOME: "/h", COLONIE_USER_DATA: "/u" }), { COLONIE_HOME: "/h", COLONIE_USER_DATA: "/u" });
});

test("workspaces sit under the development home when one is set, the real home otherwise", () => {
  assert.equal(colonieHome(HOME, {}), HOME);
  assert.equal(colonieHome(HOME, { COLONIE_HOME: "/dev" }), "/dev");
});

test("a new workspace keeps tool steps out of the transcript, as the setting says", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "colonie-config-"));
  try {
    initializeColonieData(dir);
    assert.equal(JSON.parse(readFileSync(path.join(dir, "config.json"), "utf8")).features.showToolCalls, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
