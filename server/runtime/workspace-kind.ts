// Whether this workspace is Shared (people are invited) or Local (one person).
//
// A workspace is created as one kind and never converted, so Shared is a
// latch: a marker file in the workspace folder, written the first time the
// workspace names members and never removed. Once Shared, every signed-in
// person — the owner and admins included — sees only the conversations they
// take part in (server/colonie/bots/bot-visibility.ts). A Local workspace
// never writes the marker and behaves exactly as before.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SHARED_WORKSPACE_MARKER = "shared-workspace";

export interface WorkspaceKindInput {
  dataDir: string;
  /** True once anyone may sign in to the workspace (admins or members). */
  namesMembers: () => boolean;
  env?: NodeJS.ProcessEnv;
}

export function createWorkspaceKind({ dataDir, namesMembers, env = process.env }: WorkspaceKindInput) {
  const marker = join(dataDir, SHARED_WORKSPACE_MARKER);
  let shared = false;
  return {
    /** Checked on every request, so a Local answer is re-read each time (members
     * can be added at any moment) and a Shared answer is kept for good. */
    shared(): boolean {
      if (shared) return true;
      if (env.COLONIE_WORKSPACE_KIND === "shared" || existsSync(marker)) return (shared = true);
      if (!namesMembers()) return false;
      writeFileSync(marker, "Shared workspace: conversations are private to their participants.\n", { mode: 0o600 });
      return (shared = true);
    },
  };
}
