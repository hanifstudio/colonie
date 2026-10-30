// A real Colonie server with an isolated home, fake ACP engine and fake browser.
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempDir } from "./cleanup.ts";
import { startSharedWorkspace, type SharedWorkspace } from "./shared-workspace.ts";

export const BROWSER_OWNER = "browser-owner@example.com";
export async function startBrowserWorkspace(shared: boolean, config: Record<string, unknown> = {}): Promise<SharedWorkspace> {
  const engineDir = mkdtempSync(join(tmpdir(), "colonie-browser-only-"));
  const engine = join(engineDir, "agent-browser");
  writeFileSync(engine, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dirname, "fake-agent-browser.mjs")}" "$@"\n`);
  chmodSync(engine, 0o755);
  let ws: SharedWorkspace;
  try { ws = await startSharedWorkspace(shared ? [{ email: BROWSER_OWNER, admin: true }] : [], config, () => ({ COLONIE_AGENT_BROWSER_PATH: engine })); }
  catch (error) { await removeTempDir(engineDir); throw error; }
  return {
    ...ws,
    as: shared ? ws.as : async (_email, path, init = {}) => {
      const response = await fetch(`${ws.url}${path}`, { method: init.method ?? "GET", headers: { "content-type": "application/json" },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
      return { status: response.status, body: await response.json().catch(() => null) };
    },
    stop: async () => { try { await ws.stop(); } finally { await removeTempDir(engineDir); } },
  };
}

export async function browserAnswer(ws: SharedWorkspace, botId: string, text: string, approveRetiredTool = false): Promise<{ text: string; threadId: string }> {
  const sent = await ws.as(BROWSER_OWNER, `/api/bots/${botId}/messages`, { method: "POST", body: { text } });
  if (sent.status !== 202) throw new Error(`Send failed: ${sent.status} ${JSON.stringify(sent.body)}`);
  const threadId = sent.body.threadId;
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    const bot = (await ws.as(BROWSER_OWNER, "/api/bots")).body.bots.find((entry: any) => entry.id === botId);
    const messages = (await ws.as(BROWSER_OWNER, `/api/threads/${threadId}/messages`)).body.messages ?? [];
    if (approveRetiredTool) {
      const card = messages.findLast((entry: any) => entry.card?.requestId && !entry.card.answered && !entry.card.dismissed);
      if (card) {
        const allowed = await ws.as(BROWSER_OWNER, `/api/threads/${threadId}/respond`, { method: "POST", body: { requestId: card.card.requestId, behavior: "allow" } });
        if (allowed.status !== 200) throw new Error(`Fixture approval failed: ${allowed.status}`);
      }
    }
    const source = messages.findLastIndex((entry: any) => entry.role === "user" && entry.kind === "text" && entry.text === text);
    const last = source < 0 ? undefined : messages.slice(source + 1).findLast((entry: any) => entry.role === "bot" && entry.kind === "text" && entry.text);
    if (last && !bot?.tasks.find((task: any) => task.threadId === threadId)?.busy) return { text: last.text, threadId };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`The fixture did not answer: ${ws.log().slice(-2500)}`);
}
