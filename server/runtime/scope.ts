// The workspace owns its paths.
//
// One workspace per data directory today, so the active scope is derived from
// the directory the process was started with. A second workspace is simply
// another scope, built from another directory, and shares nothing below it —
// which is what makes "workspace B does not inherit workspace A's bots,
// keys or sign-ins" true by construction instead of by convention.
import { homedir } from "node:os";
import { join } from "node:path";

import { colonieDataDir } from "../../electron/colonie-config.mjs";
import { colonieProfile } from "../acp/profile.ts";

// COLONIE_DATA_DIR isolates test/soak rigs from the user's real fleet. The
// resolution lives here, not in config.ts, so that the paths under a workspace
// — including the file that holds its engine setup and keys — have exactly one
// owner and the dependency only ever points this way.
export const DATA_DIR = process.env.COLONIE_DATA_DIR ?? (colonieProfile() ? colonieDataDir(homedir()) : join(homedir(), ".colonie"));
export const EVENTS_DIR = join(DATA_DIR, "events");
export const NATIVE_DIR = join(DATA_DIR, "native");

export interface WorkspaceScope {
  /** Everything this workspace persists itself. */
  readonly dataDir: string;
  /** Per-engine isolated directories, so a workspace's sign-ins are its own. */
  readonly nativeDir: string;
  /** Per-thread execution logs, kept with the workspace's own data. */
  readonly eventsDir: string;
  /** The workspace's settings: engine setup, keys, features. */
  readonly configFile: string;
  /** The workspace's conversations. */
  readonly messageDbFile: string;
  readonly botsFile: string;
  readonly groupsFile: string;
  /** Written once a workspace's older per-thread model copies are cleared. */
  readonly threadModelCopiesCleared: string;
  /** A thread's transcript file from before the message database. */
  readonly legacyThreadFile: (threadId: string) => string;
}

/** The paths of the workspace rooted at `dataDir`. */
export function workspaceScope(dataDir: string): WorkspaceScope {
  return {
    dataDir,
    nativeDir: join(dataDir, "native"),
    eventsDir: join(dataDir, "events"),
    configFile: join(dataDir, "config.json"),
    messageDbFile: join(dataDir, "messages.db"),
    botsFile: join(dataDir, "bots.json"),
    groupsFile: join(dataDir, "groups.json"),
    threadModelCopiesCleared: join(dataDir, "thread-model-copies-cleared"),
    legacyThreadFile: (threadId: string) => join(dataDir, `messages-${threadId}.json`),
  };
}

/** The workspace this process runs in. A workspace switcher hands the
 * bootstrap another scope instead of changing this default. */
export function activeWorkspaceScope(): WorkspaceScope {
  return workspaceScope(DATA_DIR);
}
