// The browser feature's process-local construction, lifted out of index.ts: one BrowserRuntime and the viewer that mirrors it, the map of throwaway guest sessions, and the cleanup outbox that clears a deleted bot's or profile's saved engine state on every host.
import { browserEngineEncryptionKey, browserEngineStatus, browserSessionId, clearBrowserSessionState, closeBrowserSession, setBrowserViewport } from "../../colonie/computer/browser-engine.ts";
import { BrowserCleanupCoordinator } from "../../colonie/computer/browser-lifecycle-cleanup.ts";
import { BrowserLive } from "../../colonie/computer/browser-live.ts";
import { BrowserRuntime, browserRuntimeEnv } from "../../colonie/computer/browser-runtime.ts";
import { DATA_DIR, browserProfilePartitionTarget } from "../../config.ts";
import { augmentedPath } from "../../runtime/env-path.ts";
import { join } from "node:path";

/** Everything this cluster reaches in the server; see the header. */
export interface BrowserSessionsDeps {
  // ponytail: one permissive shape instead of hand-typed lines for each name;
  // tighten it when this cluster gets tests of its own.
  [name: string]: any;
}

export function createBrowserSessions(deps: BrowserSessionsDeps) {
  const { cfg } = deps;


// Browser data of a deleted bot or profile: the engine's saved session
// state, cleared here on every host (the desktop no longer owns a browser).
// The coordinator keeps its durable journal and replay; this is its outbox.
const browserCleanup: BrowserCleanupCoordinator = new BrowserCleanupCoordinator({
  file: join(DATA_DIR, "browser-cleanups.json"),
  send: (request) => {
    // Cleanup may only run the engine Colonie itself configured or
    // downloaded. A binary the ambient PATH turned up — on a dev machine, a
    // global wrapper that shadows the harness PATH and rewrites the session
    // key — is not that engine: a close through it can fail and wedge the
    // journal on retries. Without a managed engine no daemon could still
    // autosave the session, so the erase below can acknowledge directly.
    const status = browserEngineStatus({ managedOnly: true });
    // Guest sessions are throwaway and never saved, so only the bot's own
    // session and shared profile sessions have state to clear.
    const sessions = request.type === "colonie:browser-bot-deleted" && request.botId
      ? [browserSessionId(request.botId, "")]
      : request.partitionId
        ? [browserSessionId("", request.partitionId)]
        : [];
    // Failed erasure leaves the committed intent pending for retry; it must
    // never acknowledge that saved state was removed when it was not.
    const work = status.kind === "ready" && sessions.length
      ? Promise.all(sessions.map(async (session) => {
          const ok = await clearBrowserSessionState(status.binaryPath, session, { encryptionKey: browserEngineEncryptionKey() });
          if (!ok) console.warn(`browser cleanup: could not clear saved state for session ${session}; restart Colonie to retry this profile's cleanup. Do not use state clear --all: it erases other profiles too.`);
          return ok;
        }))
      : Promise.resolve([true]);
    void work.then((results) => results.every(Boolean), (error) => {
      console.warn("browser cleanup: could not clear saved session state", error);
      return false;
    }).then((ok) => {
      browserCleanup.receive({ type: "colonie:browser-lifecycle-result", requestId: request.requestId, ok });
    }).catch((error) => {
      console.warn("browser cleanup: could not acknowledge cleanup", error);
    });
    return true;
  },
});
/** The bot's browser for this turn: agent-browser, one isolated session per
 * browser profile or per bot (docs/plans/browser-engine.md). Null, with the
 * reason logged once, when the engine is not on this machine. */
const browserRuntime = new BrowserRuntime({
  // The bot's restart_browser tool. An open Browser panel watched the old
  // browser; drop its stream the way the panel's own Restart button does.
  closeBrowser: async (session, spec) => {
    const closed = await closeBrowserSession(spec.command, browserRuntimeEnv({ ...spec.env, AGENT_BROWSER_SESSION: session }));
    if (closed) browserLive.closeForSession(session);
    return closed;
  },
  applyViewport: (spec) => setBrowserViewport(spec.command, spec.env),
});
const browserLive = new BrowserLive({ runtime: browserRuntime });
// Temporary profiles last for this server run, but are never saved to disk.
// The viewer and the agent must address the SAME temporary browser.
const temporaryBrowserSessions = new Map<string, string>();
function currentBrowserSession(botId: string, profile: string | undefined): string {
  if (profile === "guest") {
    let session = temporaryBrowserSessions.get(botId);
    if (!session) {
      session = browserSessionId(botId, "guest");
      temporaryBrowserSessions.set(botId, session);
    }
    return session;
  }
  const target = profile ? browserProfilePartitionTarget(cfg, profile) : null;
  return browserSessionId(botId, target?.partitionId ?? "");
}
async function forgetTemporaryBrowser(botId: string): Promise<void> {
  const session = temporaryBrowserSessions.get(botId);
  if (!session) return;
  temporaryBrowserSessions.delete(botId);
  const engine = browserEngineStatus();
  if (engine.kind !== "ready") return;
  const closed = await clearBrowserSessionState(engine.binaryPath, session, {
    env: { PATH: augmentedPath() }, encryptionKey: browserEngineEncryptionKey(),
  });
  if (closed) await browserRuntime.close(session);
  else console.warn(`temporary browser ${session}: could not close its session; run agent-browser --session ${session} close on this server`);
}

  return {
    browserCleanup,
    browserRuntime,
    browserLive,
    currentBrowserSession,
    forgetTemporaryBrowser,
    temporaryBrowserSessions,
  };
}
