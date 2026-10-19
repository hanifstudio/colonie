// These three helpers decide where the app keeps its own folder (the workspace
// list) and where a workspace keeps its data. The launcher reads the first
// without Electron, so the mirror has to answer the way Electron answers.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { colonieAppData, colonieDataDir, colonieUserData } from "./colonie-config.mjs";

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
