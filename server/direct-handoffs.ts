import { readFileSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";

const nodeSchema = z.object({
  id: z.string(), rootId: z.string(), parentId: z.string().optional(),
  // Legacy room fields: stored room trees still load as settled history.
  groupId: z.string().optional(), threadId: z.string(), botId: z.string(),
  key: z.string(), text: z.string(), createdAt: z.number(),
  requestBatchKey: z.string().optional(),
  status: z.enum(["source", "queued", "running", "waiting", "resume", "completed", "failed", "cancelled"]),
  result: z.string().default(""), reported: z.boolean().default(false),
  executions: z.number().int().nonnegative().default(0), startedAt: z.number().optional(),
  lastProgressAt: z.number().optional(),
  approvalGranted: z.boolean().default(false),
  kind: z.enum(["work", "assignment"]).default("work"),
});
export type DirectHandoff = z.infer<typeof nodeSchema>;
const terminal = (n: DirectHandoff) => ["completed", "failed", "cancelled"].includes(n.status);

/** Stored direct-coordination trees, read as settled history.
 *
 * `coordinate_bots` lived on the native agents MCP server, which no ACP adapter
 * mounts, so nothing on the ACP fleet can create or dispatch a node. Chief
 * delegation runs through the colonie_workspace `ask_bot` tool instead
 * (server/colonie/chief). What remains is the file an older build wrote:
 * every node loads terminal and already reported, so a stored tree never
 * resumes a conversation or posts a late result after an upgrade. Earlier
 * results stay readable for the transcript (`roomRequest` messages).
 */
export class DirectHandoffs {
  readonly nodes = new Map<string, DirectHandoff>();

  constructor(file: string) {
    try {
      const saved = z.array(nodeSchema).max(10_000).parse(JSON.parse(readFileSync(file, "utf8")));
      const ids = new Map(saved.map(n => [n.id, n]));
      if (ids.size !== saved.length || saved.some(n => !ids.has(n.rootId) || ids.get(n.rootId)?.parentId ||
        (n.parentId && (!ids.has(n.parentId) || ids.get(n.parentId)?.rootId !== n.rootId)))) throw new Error("Invalid handoff tree");
      let changed = false;
      for (const n of saved) {
        if (!terminal(n)) { n.status = "failed"; n.result = "Interrupted by server restart; not replayed."; changed = true; }
        if (!n.reported) { n.reported = true; changed = true; }
        this.nodes.set(n.id, n);
      }
      if (changed) writeFileAtomic(file, JSON.stringify(saved), { mode: 0o600 });
    } catch (e) {
      // Unreadable history is left on disk untouched for repair; nothing
      // reads it except old transcript lookups, which then report it gone.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`handoffs: stored delegation history is unreadable: ${String(e)}`);
    }
  }

  children(id: string) { return [...this.nodes.values()].filter(n => n.parentId === id); }
}
