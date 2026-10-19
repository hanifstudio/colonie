// The workspace list decides which directory the app runs in. Two things must
// hold no matter what the list says: an installation with no list runs the
// directory it has always used, and no second workspace is ever pointed at that
// directory — that is the whole point of having workspaces at all.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_WORKSPACE_ID,
  WORKSPACES_FILE,
  WORKSPACE_NAME_MAX,
  activeWorkspace,
  createLocalWorkspace,
  readWorkspaces,
  setActiveWorkspace,
  workspacesFilePath,
} from "./local-workspaces.mjs";

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

test("creating a workspace gives it a directory of its own and leaves the running one alone", () => {
  const { home, userData } = installation();
  writeList(userData, {
    activeId: "work",
    workspaces: [{ id: "work", name: "Work", dir: path.join(home, ".colonie-workspaces", "work") }],
  });

  const created = createLocalWorkspace({ home, userData, env: {}, name: "  Design lab " });

  assert.equal(created.name, "Design lab", "the name is trimmed");
  assert.equal(created.id, "design-lab");
  assert.equal(created.dir, path.join(home, ".colonie-workspaces", "design-lab"));
  assert.ok(existsSync(created.dir), "the new workspace has its own directory");

  const { activeId, workspaces } = readWorkspaces({ home, userData, env: {} });
  assert.deepEqual(workspaces.map((workspace) => workspace.id), ["local-default", "work", "design-lab"]);
  assert.equal(activeId, "work", "creating a workspace does not change which one runs");
  assert.equal(activeWorkspace({ home, userData, env: {} }).id, "work");
  // The default workspace's directory is derived from the environment, so it is
  // never written down: an override would then disagree with the stored path.
  const stored = readFileSync(workspacesFilePath(userData), "utf8");
  assert.ok(!stored.includes(`${path.join(home, ".colonie")}"`), "the default directory is not stored");
});

test("a created workspace can be made the active one", () => {
  const { home, userData } = installation();
  const created = createLocalWorkspace({ home, userData, env: {}, name: "Design lab" });

  writeList(userData, {
    activeId: created.id,
    workspaces: [{ id: created.id, name: created.name, dir: created.dir }],
  });

  const active = activeWorkspace({ home, userData, env: {} });
  assert.equal(active.id, "design-lab");
  assert.equal(active.dir, created.dir);
});

test("two workspaces with the same name still get their own id and directory", () => {
  const { home, userData } = installation();

  const first = createLocalWorkspace({ home, userData, env: {}, name: "Project" });
  const second = createLocalWorkspace({ home, userData, env: {}, name: "Project" });

  assert.equal(first.id, "project");
  assert.equal(second.id, "project-2");
  assert.notEqual(first.dir, second.dir);
  assert.deepEqual(
    readWorkspaces({ home, userData, env: {} }).workspaces.map((workspace) => workspace.id),
    [DEFAULT_WORKSPACE_ID, "project", "project-2"],
  );
});

test("a name never adopts a directory that is already on disk", () => {
  const { home, userData } = installation();
  // Data this app knows nothing about, sitting where the new workspace would go.
  mkdirSync(path.join(home, ".colonie-workspaces", "project"), { recursive: true });

  const created = createLocalWorkspace({ home, userData, env: {}, name: "Project" });

  assert.equal(created.id, "project-2");
  assert.equal(created.dir, path.join(home, ".colonie-workspaces", "project-2"));
});

test("a workspace needs a usable name, and nothing is created without one", () => {
  const { home, userData } = installation();

  assert.throws(() => createLocalWorkspace({ home, userData, env: {}, name: "   " }), /needs a name/);
  assert.throws(() => createLocalWorkspace({ home, userData, env: {} }), /needs a name/);
  assert.throws(
    () => createLocalWorkspace({ home, userData, env: {}, name: "x".repeat(WORKSPACE_NAME_MAX + 1) }),
    /at most/,
  );

  assert.ok(!existsSync(path.join(home, ".colonie-workspaces")), "no workspace directory was created");
  assert.ok(!existsSync(workspacesFilePath(userData)), "no list was written");
});

test("a list that cannot be read is refused instead of replaced", () => {
  const { home, userData } = installation();
  writeList(userData, "{ this is not json");

  assert.throws(() => createLocalWorkspace({ home, userData, env: {}, name: "Design" }), /could not be read/);

  assert.equal(readFileSync(workspacesFilePath(userData), "utf8"), "{ this is not json");
  assert.ok(!existsSync(path.join(home, ".colonie-workspaces", "design")), "no directory was created");
});

test("switching makes another workspace the one that runs and keeps every record", () => {
  const { home, userData } = installation();
  const first = createLocalWorkspace({ home, userData, env: {}, name: "Design lab" });
  const second = createLocalWorkspace({ home, userData, env: {}, name: "Client work" });

  assert.equal(activeWorkspace({ home, userData, env: {} }).id, DEFAULT_WORKSPACE_ID);

  const active = setActiveWorkspace({ home, userData, env: {}, id: second.id });
  assert.equal(active.id, "client-work");
  assert.equal(activeWorkspace({ home, userData, env: {} }).id, "client-work");
  assert.equal(activeWorkspace({ home, userData, env: {} }).dir, second.dir);
  assert.deepEqual(
    readWorkspaces({ home, userData, env: {} }).workspaces.map((workspace) => workspace.id),
    [DEFAULT_WORKSPACE_ID, "design-lab", "client-work"],
  );

  // Back to the first workspace, which is the historical directory.
  setActiveWorkspace({ home, userData, env: {}, id: DEFAULT_WORKSPACE_ID });
  assert.equal(activeWorkspace({ home, userData, env: {} }).dir, path.join(home, ".colonie"));

  // Switching moves the choice, never the data: the records point where they did.
  assert.equal(
    readWorkspaces({ home, userData, env: {} }).workspaces.find((workspace) => workspace.id === first.id).dir,
    first.dir,
  );
});

test("switching to an id nobody listed is refused and changes nothing", () => {
  const { home, userData } = installation();
  createLocalWorkspace({ home, userData, env: {}, name: "Design lab" });
  const before = readFileSync(workspacesFilePath(userData), "utf8");

  assert.throws(() => setActiveWorkspace({ home, userData, env: {}, id: "ghost" }), /no workspace is listed as ghost/);
  assert.throws(() => setActiveWorkspace({ home, userData, env: {}, id: "   " }), /needs an id/);

  assert.equal(readFileSync(workspacesFilePath(userData), "utf8"), before);
  assert.equal(activeWorkspace({ home, userData, env: {} }).id, DEFAULT_WORKSPACE_ID);
});

test("an explicit data directory still wins over the recorded choice", () => {
  const { home, userData } = installation();
  const created = createLocalWorkspace({ home, userData, env: {}, name: "Design lab" });
  setActiveWorkspace({ home, userData, env: {}, id: created.id });

  const rig = activeWorkspace({ home, userData, env: { COLONIE_DATA_DIR: "/tmp/rig" } });
  assert.equal(rig.id, DEFAULT_WORKSPACE_ID);
  assert.equal(rig.dir, "/tmp/rig");
});

test("switching refuses a list it cannot read too", () => {
  const { home, userData } = installation();
  writeList(userData, "{ this is not json");

  assert.throws(
    () => setActiveWorkspace({ home, userData, env: {}, id: DEFAULT_WORKSPACE_ID }),
    /could not be read/,
  );

  assert.equal(readFileSync(workspacesFilePath(userData), "utf8"), "{ this is not json");
});
