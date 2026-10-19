// The workspace owns its paths.
//
// One workspace per data directory today, so the active scope is derived from
// the directory the process was started with. A second workspace is simply
// another scope, built from another directory, and shares nothing below it —
// which is what makes "workspace B does not inherit workspace A's bots,
// keys or sign-ins" true by construction instead of by convention.
import { join } from "node:path";

import { DATA_DIR } from "../config.ts";

export interface WorkspaceScope {
  /** Everything this workspace persists itself. */
  readonly dataDir: string;
  /** Per-engine isolated directories, so a workspace's sign-ins are its own. */
  readonly nativeDir: string;
  /** Per-thread execution logs, kept with the workspace's own data. */
  readonly eventsDir: string;
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
