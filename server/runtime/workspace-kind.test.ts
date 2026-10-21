// A workspace becomes Shared once and stays Shared: the marker is written the
// first time it names members and never removed. A Local workspace writes
// nothing and stays exactly as it was.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { createWorkspaceKind, SHARED_WORKSPACE_MARKER } from "./workspace-kind.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const folder = () => { const dir = mkdtempSync(join(tmpdir(), "colonie-kind-")); dirs.push(dir); return dir; };

test("a workspace with no members is Local and writes nothing", () => {
  const dataDir = folder();
  const kind = createWorkspaceKind({ dataDir, namesMembers: () => false, env: {} });
  expect(kind.shared()).toBe(false);
  expect(existsSync(join(dataDir, SHARED_WORKSPACE_MARKER))).toBe(false);
});

test("naming members makes it Shared for good, even after the list empties", () => {
  const dataDir = folder();
  let members = true;
  const kind = createWorkspaceKind({ dataDir, namesMembers: () => members, env: {} });
  expect(kind.shared()).toBe(true);
  members = false;
  expect(kind.shared()).toBe(true);
  // and a restart reads the marker, not the (now empty) list
  expect(createWorkspaceKind({ dataDir, namesMembers: () => false, env: {} }).shared()).toBe(true);
});

test("a test server can start Shared without writing a marker", () => {
  const dataDir = folder();
  const kind = createWorkspaceKind({ dataDir, namesMembers: () => false, env: { COLONIE_WORKSPACE_KIND: "shared" } });
  expect(kind.shared()).toBe(true);
  expect(existsSync(join(dataDir, SHARED_WORKSPACE_MARKER))).toBe(false);
});
