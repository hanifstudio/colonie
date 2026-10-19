// The Local workspaces this app knows about, and which one it runs.
//
// A Local workspace is a name and a data directory. Everything the app owns for
// that workspace — bots, conversations, settings, engine sign-ins — lives inside
// its directory, so two workspaces have nothing in common. The list itself
// cannot live inside a workspace, because the list is what points at them; it
// sits in the app's own data folder instead.
//
// One workspace runs per server process. The engine side is already built that
// way: each data directory carries its own lease, so two workspaces are two
// processes that cannot collide, and a second process on the same directory is
// refused rather than sharing it.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const WORKSPACES_FILE = "workspaces.json";
/** The workspace every installation starts with, at the historical directory. */
export const DEFAULT_WORKSPACE_ID = "local-default";
/** Provisional display name; renaming is the owner's call, not an assumption. */
export const DEFAULT_WORKSPACE_NAME = "My workspace";
/** Workspaces created later get a directory of their own beside the first. */
const WORKSPACES_PARENT_DIR = ".colonie-workspaces";

/**
 * The data directory of the workspace every installation starts with. An
 * override wins even when it is set but empty, because the server reads an empty
 * value differently: leasing one directory and running in another is the failure
 * this return value exists to prevent.
 */
export function defaultWorkspaceDir(home, env = process.env) {
  return env.COLONIE_DATA_DIR || join(home, ".colonie");
}

/** Where a workspace created later keeps its data. */
export function workspaceDirFor(home, id) {
  return join(home, WORKSPACES_PARENT_DIR, id);
}

export function workspacesFilePath(userData) {
  return join(userData, WORKSPACES_FILE);
}

function field(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * The workspaces this app knows about, always starting with the default one.
 * A listed record is dropped rather than trusted when it has no id or name, has
 * no usable directory, repeats an id, or points at the default workspace's
 * directory — the last one because two workspaces sharing one directory is
 * exactly the harm this module exists to prevent. A missing or unreadable list
 * is a fresh installation, not an error.
 */
export function readWorkspaces({ home, userData, env = process.env }) {
  const first = { id: DEFAULT_WORKSPACE_ID, name: DEFAULT_WORKSPACE_NAME, dir: defaultWorkspaceDir(home, env) };
  const workspaces = [first];
  const known = new Set([first.id]);
  let raw = null;
  try {
    raw = JSON.parse(readFileSync(workspacesFilePath(userData), "utf8"));
  } catch {
    return { activeId: first.id, workspaces };
  }
  for (const entry of Array.isArray(raw?.workspaces) ? raw.workspaces : []) {
    const id = field(entry?.id);
    const name = field(entry?.name);
    const dir = field(entry?.dir);
    if (!id || !name || !dir || known.has(id) || dir === first.dir) continue;
    known.add(id);
    workspaces.push({ id, name, dir });
  }
  // An explicit data directory is a rig or developer choice: it means "run the
  // default workspace here", never a listed one.
  if (env.COLONIE_DATA_DIR) return { activeId: first.id, workspaces };
  const activeId = field(raw?.activeId);
  return { activeId: activeId && known.has(activeId) ? activeId : first.id, workspaces };
}

/** The workspace this app runs now. */
export function activeWorkspace(options) {
  const { activeId, workspaces } = readWorkspaces(options);
  return workspaces.find((workspace) => workspace.id === activeId) ?? workspaces[0];
}
