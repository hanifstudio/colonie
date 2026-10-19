// The workspace list decides which directory the app runs in. Two things must
// hold no matter what the list says: an installation with no list runs the
// directory it has always used, and no second workspace is ever pointed at that
// directory — that is the whole point of having workspaces at all.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { WORKSPACES_FILE, activeWorkspace, readWorkspaces, workspacesFilePath } from "./local-workspaces.mjs";

const roots = [];

test.afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A fresh home and app-data folder, the way a new installation looks. */
function installation() {
  const root = mkdtempSync(path.join(tmpdir(), "colonie-workspaces-"));
  roots.push(root);
  const home = path.join(root, "home");
  const userData = path.join(root, "userData");
  mkdirSync(userData, { recursive: true });
  return { home, userData };
}

function writeList(userData, contents) {
  writeFileSync(workspacesFilePath(userData), typeof contents === "string" ? contents : JSON.stringify(contents));
}

test("the default workspace is the directory the app has always used", () => {
  const { home, userData } = installation();

  assert.equal(activeWorkspace({ home, userData, env: {} }).dir, path.join(home, ".colonie"));
  // An override that is set but empty still wins: the server reads an empty
  // value differently, so resolving it another way here would lease one
  // directory and run in another.
  assert.equal(activeWorkspace({ home, userData, env: { COLONIE_DATA_DIR: "" } }).dir, path.join(home, ".colonie"));
  assert.equal(activeWorkspace({ home, userData, env: { COLONIE_DATA_DIR: "/tmp/rig" } }).dir, "/tmp/rig");
});

test("a listed workspace keeps its own directory and can be the active one", () => {
  const { home, userData } = installation();
  writeList(userData, {
    activeId: "work",
    workspaces: [
      { id: "personal", name: "Personal", dir: path.join(home, ".colonie-workspaces", "personal") },
      { id: "work", name: "Work", dir: path.join(home, ".colonie-workspaces", "work") },
    ],
  });

  const { activeId, workspaces } = readWorkspaces({ home, userData, env: {} });
  assert.equal(activeId, "work");
  assert.deepEqual(workspaces.map((workspace) => workspace.id), ["local-default", "personal", "work"]);
  assert.equal(activeWorkspace({ home, userData, env: {} }).name, "Work");
});

test("an explicit data directory always means the default workspace", () => {
  const { home, userData } = installation();
  writeList(userData, {
    activeId: "work",
    workspaces: [{ id: "work", name: "Work", dir: path.join(home, ".colonie-workspaces", "work") }],
  });

  const workspace = activeWorkspace({ home, userData, env: { COLONIE_DATA_DIR: "/tmp/rig" } });
  assert.equal(workspace.id, "local-default");
  assert.equal(workspace.dir, "/tmp/rig");
});

test("no two workspaces are ever pointed at the same directory", () => {
  const { home, userData } = installation();
  writeList(userData, {
    activeId: "copy",
    workspaces: [
      // A second workspace aimed at the default directory would share bots,
      // conversations and sign-ins with the first one.
      { id: "copy", name: "Copy", dir: path.join(home, ".colonie") },
      { id: "twice", name: "Twice", dir: path.join(home, ".colonie-workspaces", "twice") },
      { id: "twice", name: "Twice again", dir: path.join(home, ".colonie-workspaces", "twice-again") },
      { id: "", name: "Nameless", dir: path.join(home, ".colonie-workspaces", "nameless") },
      { id: "no-dir", name: "No directory" },
    ],
  });

  const { activeId, workspaces } = readWorkspaces({ home, userData, env: {} });
  assert.deepEqual(workspaces.map((workspace) => workspace.id), ["local-default", "twice"]);
  const directories = workspaces.map((workspace) => workspace.dir);
  assert.equal(new Set(directories).size, directories.length);
  // The dropped entries cannot become active just because they asked to be.
  assert.equal(activeId, "local-default");
});

test("a missing, unreadable or unknown list leaves the default workspace", () => {
  const { home, userData } = installation();

  assert.deepEqual(readWorkspaces({ home, userData, env: {} }).workspaces.map((w) => w.id), ["local-default"]);

  writeList(userData, "{ this is not json");
  assert.deepEqual(readWorkspaces({ home, userData, env: {} }).workspaces.map((w) => w.id), ["local-default"]);

  writeList(userData, { activeId: "ghost", workspaces: [] });
  assert.equal(readWorkspaces({ home, userData, env: {} }).activeId, "local-default");

  assert.equal(workspacesFilePath(userData), path.join(userData, WORKSPACES_FILE));
  assert.equal(activeWorkspace({ home, userData, env: {} }).id, "local-default");
});
