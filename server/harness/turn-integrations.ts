// The per-turn MCP and hook integrations mounted into one ACP session: the agent-tools proxy, the engine lifecycle hook channel, the built-in browser proxy, the connected-apps bridge and the computer-control endpoint. Each mints a turn-scoped internal capability and hands the adapter the command, env or loopback URL it should mount.
import * as tts from "../tts/index.ts";
import * as composio from "../colonie/mcp/composio.ts";
import { type LocalVmTarget } from "../colonie/computer/container-computer.ts";
import { type BotRecord } from "../persistence/store.ts";
import { agentBrowserIntegration, browserEngineEncryptionKey, browserEngineStatus, describeBrowserEngine, prepareBrowserSessionState } from "../colonie/computer/browser-engine.ts";
import { browserEngineAttachCdpUrl, browserProfilePartitionTarget, builtInBrowserEnabled } from "../config.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { augmentedPath } from "../runtime/env-path.ts";

/** Everything this cluster reaches in the server; see the header. */
export interface TurnIntegrationsDeps {
  // ponytail: one permissive shape instead of hand-typed lines for each name;
  // tighten it when this cluster gets tests of its own.
  [name: string]: any;
  setEngineUnavailableLogged: (value: any) => void,
}

export function createTurnIntegrations(deps: TurnIntegrationsDeps) {
  const {
    PORT, botForThread, cfg, lendingEnabled, mintInternalCapability, store,
    activeInternalGenerationByThread, currentBrowserSession, engineUnavailableLogged,
    setEngineUnavailableLogged
  } = deps;
const agentsProxyPath = SPAWNED_PROXIES.agents;
// in the packaged app process.execPath is Electron — run the proxy as node
const AGENTS_NODE_FLAG = { ELECTRON_RUN_AS_NODE: "1" };

function agentsIntegration(
  botId: string,
  threadId: string,
  depth: number,
  skillAuthoring: boolean,
  generation: string,
  roomCoordination = false,
  ownThreadCreation = false,
) {
  const token = mintInternalCapability({
    botId,
    threadId,
    generation,
    depth,
    kind: "agents",
    skillAuthoring,
    createdBots: 0,
    openedThreads: 0,
    roomCoordination,
    ownThreadCreation,
  });
  return {
    command: process.execPath,
    args: [agentsProxyPath],
    env: {
      ...AGENTS_NODE_FLAG,
      COLONIE_HARNESS_URL: `http://127.0.0.1:${PORT}`,
      COLONIE_BOT_ID: botId,
      COLONIE_THREAD_ID: threadId,
      COLONIE_COMMS_TOKEN: token,
      COLONIE_TURN_DEPTH: String(depth),
      COLONIE_ROOM_TURN: roomCoordination ? "1" : "0",
      COLONIE_OWN_THREAD_CREATION: ownThreadCreation ? "1" : "0",
      COLONIE_SKILL_AUTHORING_ENABLED: skillAuthoring ? "1" : "0",
      COLONIE_MEMORY_ENABLED: store().bot(botId)?.memoryEnabled === false ? "0" : "1",
      // The shared-computer tools are advertised only while the workspace
      // gate is on; the routes behind them refuse regardless.
      COLONIE_SHARED_COMPUTERS_ENABLED: lendingEnabled() ? "1" : "0",
      // Same capability rule for voice: the tool is offered only when this
      // bot can actually speak, and the route re-checks on every call.
      COLONIE_VOICE_NOTES: (() => {
        const speaking = botForThread()(botId, threadId) ?? store().bot(botId);
        return tts.voiceReady(cfg, speaking?.voice) && speaking?.voiceNotes !== false ? "1" : "0";
      })(),
      // And for a role: team setup, bot creation and deletion, rooms and
      // retries are shown only to a Chief of Staff, whom their routes require.
      COLONIE_CHIEF_OF_STAFF: store().bot(botId)?.chiefOfStaff === true ? "1" : "0",
    },
  };
}

/** Engine lifecycle hooks (item 0.2): a turn-scoped bearer for the engine's
 * hook helper. An adapter must declare `hooks` for this to be mounted, and
 * COLONIE_HOOKS=0 turns the channel off. */
const hooksEnabled = () => process.env.COLONIE_HOOKS !== "0";
function hooksIntegration(botId: string, threadId: string, generation: string): { url: string; token: string } {
  const token = mintInternalCapability({
    botId,
    threadId,
    generation,
    depth: 0,
    kind: "hooks",
    skillAuthoring: false,
    createdBots: 0,
    openedThreads: 0,
  });
  return { url: `http://127.0.0.1:${PORT}`, token };
}

async function browserIntegration(botId: string, profile: string | undefined, turn?: { threadId: string; generation: string }) {
  const status = browserEngineStatus();
  if (status.kind !== "ready") {
    if (!engineUnavailableLogged()) {
      setEngineUnavailableLogged(true);
      console.warn(`${describeBrowserEngine(status)}; bots get no browser tools until it is installed`);
    }
    return null;
  }
  // A profile that no longer exists falls back to the bot's own session.
  const profileTarget = profile && profile !== "guest" ? browserProfilePartitionTarget(cfg, profile) : null;
  const partitionId = profile === "guest" ? "guest" : (profileTarget?.partitionId ?? "");
  const session = currentBrowserSession()(botId, profile);
  const spec = agentBrowserIntegration({
      binaryPath: status.binaryPath,
      session,
      encryptionKey: browserEngineEncryptionKey(),
      persistent: profile !== "guest",
      env: { ...process.env, PATH: augmentedPath() },
      attachCdpUrl: browserEngineAttachCdpUrl(cfg) ?? undefined,
    });
  await prepareBrowserSessionState(status.binaryPath, session, { env: spec.env, persistent: profile !== "guest", isCurrent: () => {
    const current = store().bot(botId);
    return !!current && current.browser !== false && builtInBrowserEnabled(cfg)
      && currentBrowserSession()(current.id, current.browserProfile) === session
      && (!turn || activeInternalGenerationByThread.get(turn.threadId) === turn.generation);
  } });
  if (!turn) return { profile: partitionId, session, spec, integration: spec };
  const token = mintInternalCapability({ botId, ...turn, browserSession: session,
    kind: "browser", depth: 0, skillAuthoring: false, createdBots: 0, openedThreads: 0 });
  return { profile: partitionId, session, spec, integration: {
    command: process.execPath, args: [SPAWNED_PROXIES.harnessMcp, "browser"], env: {
      ...AGENTS_NODE_FLAG, COLONIE_MCP_TOKEN: token, COLONIE_HARNESS_URL: `http://127.0.0.1:${PORT}`,
    },
  } };
}
function connectedAppsIntegration(bot: Pick<BotRecord, "id" | "connectorTools">, threadId: string, generation: string) {
  const token = mintInternalCapability({
    botId: bot.id,
    threadId,
    generation,
    depth: 0,
    kind: "connectors",
    skillAuthoring: false,
    createdBots: 0,
    openedThreads: 0,
  });
  return composio.mcpIntegration(cfg, {
    harnessUrl: `http://127.0.0.1:${PORT}`,
    commsToken: token,
    botId: bot.id,
    threadId,
    // Connector grants 3/5: the record (or its absence) rides along so
    // the bridge can filter tools/list; the verdict on the relay endpoint
    // stays the authority for every call.
    connectorTools: bot.connectorTools,
  });
}

/** The loopback endpoint a bot's computer proxy polls before acting. The
 * bridge is revoked when the turn ends. This computer runs as long as the
 * app does, so its bridge keeps the thread's bearer like every other
 * integration; any other machine (a Local VM) gets a new bearer each turn. */
function controlIntegration(
  botId: string,
  threadId: string,
  generation: string,
  machine: "this computer" | { localVmTarget?: LocalVmTarget } = {},
) {
  const { localVmTarget } = machine === "this computer" ? {} : machine;
  return {
    url: `http://127.0.0.1:${PORT}/api/internal/computer-control?botId=${encodeURIComponent(botId)}`,
    token: mintInternalCapability({
      botId,
      threadId,
      generation,
      depth: 0,
      kind: "computer",
      ...(localVmTarget ? { localVmTarget } : {}),
      skillAuthoring: false,
      createdBots: 0,
      openedThreads: 0,
    }, { perTurn: machine !== "this computer" }),
  };
}

  return {
    agentsIntegration,
    browserIntegration,
    connectedAppsIntegration,
    controlIntegration,
    hooksEnabled,
    hooksIntegration,
  };
}
