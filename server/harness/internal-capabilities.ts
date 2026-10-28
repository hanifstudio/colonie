// The turn-scoped bearers every mounted proxy and integration holds: the InternalCapability record, its bearer reuse keyed by the grants it was minted for, minting and revoking a generation, and the parked computer-selection turns cleared with them. index.ts wires this once and destructures the names its dispatch, route and local-VM wiring still call.
import { type Surface } from "../surface.ts";
import { type RuntimeEvent } from "../contracts.ts";
import { type Message } from "../persistence/store.ts";
import { type LocalVmTarget } from "../colonie/computer/container-computer.ts";
import { approvalModeFor } from "../../shared/approval-mode.ts";
import { ProviderTurnGenerationRegistry } from "../colonie/chat/turn-dispatch-guard.ts";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

/** Everything this cluster reaches in the server; see the header. */
export interface InternalCapabilitiesDeps {
  // ponytail: one permissive shape instead of hand-typed lines for each name;
  // tighten it when this cluster gets tests of its own.
  [name: string]: any;
}

export function createInternalCapabilities(deps: InternalCapabilitiesDeps) {
  const {
    botForThread
  } = deps;


// ── peer-agent comms wiring ────────────────────────────────────────────
// Every mounted proxy receives a turn-scoped capability. Identity, source
// thread, recursion depth and route family all come from this server-side
// record; caller fields are assertions, never authority. Full mode can inspect
// its own MCP environment, so a credential is never shared between bots or
// threads (see sessionCredentials), and each turn's record is revoked when the
// turn ends.
type InternalCapability = {
  botId: string;
  threadId: string;
  generation: string;
  depth: number;
  kind: "agents" | "connectors" | "computer" | "browser" | "hooks";
  skillAuthoring: boolean;
  createdBots: number;
  /** start_thread calls this turn has made — capped like createdBots, so a
   * turn cannot fan out into more real turns than a person could follow. */
  openedThreads: number;
  orphanExpiresAt: number;
  localVmTarget?: LocalVmTarget;
  browserSession?: string;
  roomCoordination?: boolean;
  ownThreadCreation?: boolean;
  /** attach_file calls this turn has made, capped so one turn cannot flood the chat. */
  attachedFiles?: number;
  /** Delegations this turn handed out: their ids may not be checked or
   * waited on until a later turn, so the teammate gets to work first. */
  delegatedThisTurn?: Set<string>;
};
// A capability lives for the exact provider-turn generation, including while
// that turn is parked on a human approval. The long ceiling is only an orphan
// backstop for an impossible-to-settle adapter; normal terminal paths revoke
// synchronously and app restart destroys this in-memory set.
const INTERNAL_CAPABILITY_ORPHAN_MS = 30 * 24 * 60 * 60_000;
const internalCapabilities = new Map<string, InternalCapability>();
const activeInternalGenerationByThread = new Map<string, string>();
const internalGenerationByProviderTurn = new ProviderTurnGenerationRegistry();
const computerSelectionTurns = new Map<string, {
  generation: string;
  botId: string;
  source: Message;
  text: string;
  mounted?: Surface;
  selected?: Surface;
  previousSurface?: Surface;
}>();

function beginInternalCapabilityGeneration(threadId: string, generation = randomUUID()): string {
  const previous = activeInternalGenerationByThread.get(threadId);
  if (previous) revokeInternalCapabilityGeneration(threadId, previous);
  activeInternalGenerationByThread.set(threadId, generation);
  return generation;
}

// The bearer an integration's proxy holds is part of the engine's launch
// contract (Claude's process key, ACP's session inputs): a new one every turn
// meant a relaunch, a resumed transcript and new MCP servers every turn. So
// the bearer stays the same while the same bot works the same thread with the
// same grants and approval level, and only the record behind it is per turn:
// between turns, and after any revoke, nothing honours it. A changed grant,
// Stop, a stall, a deleted bot or thread or a provider reload gives the next
// turn a new bearer, so whatever still holds the old one is never honoured
// again.
/** threadId → "botId kind" → the bearer and the grants it was minted for. */
const sessionCredentials = new Map<string, Map<string, { grants: string; token: string }>>();

/** What a bearer stands for: everything its record grants (a turn's counters
 * all start at zero), plus the thread's approval level; not the turn. */
function sessionGrants({ generation: _turn, ...grants }: Omit<InternalCapability, "orphanExpiresAt">): string {
  const thread = botForThread()(grants.botId, grants.threadId);
  return JSON.stringify({ ...grants, approval: thread ? approvalModeFor(thread) : null });
}

/** The thread's bearer for this integration, new only when its grants changed. */
function sessionBearer(capability: Omit<InternalCapability, "orphanExpiresAt">): string {
  const credentials = sessionCredentials.get(capability.threadId) ?? new Map<string, { grants: string; token: string }>();
  sessionCredentials.set(capability.threadId, credentials);
  const slot = `${capability.botId} ${capability.kind}`;
  const grants = sessionGrants(capability);
  const held = credentials.get(slot);
  if (held?.grants === grants) return held.token;
  const token = randomBytes(24).toString("hex");
  credentials.set(slot, { grants, token });
  return token;
}

function mintInternalCapability(capability: Omit<InternalCapability, "orphanExpiresAt">, { perTurn = false } = {}): string {
  if (activeInternalGenerationByThread.get(capability.threadId) !== capability.generation) {
    throw new Error("cannot mint an integration capability for an inactive turn");
  }
  // perTurn: a bridge into a machine the harness stops and starts between
  // turns (a Local VM). A warm engine never restarts a server whose machine
  // went away, so such a turn gets a new bearer and starts its engine fresh.
  const token = perTurn ? randomBytes(24).toString("hex") : sessionBearer(capability);
  // Minted twice in one turn: keep that turn's record and its counters.
  if (internalCapabilities.get(token)?.generation !== capability.generation) {
    internalCapabilities.set(token, {
      ...capability,
      orphanExpiresAt: Date.now() + INTERNAL_CAPABILITY_ORPHAN_MS,
    });
  }
  return token;
}

/** Honoured only during the turn it was minted for, and not once that turn
 * has chosen to move to another computer. */
function internalCapabilityIsActive(capability: InternalCapability): boolean {
  const switching = computerSelectionTurns.get(capability.threadId);
  if ((capability.kind === "computer" || capability.kind === "browser") &&
      switching?.generation === capability.generation && switching.selected) return false;
  return capability.orphanExpiresAt > Date.now() && activeInternalGenerationByThread.get(capability.threadId) === capability.generation;
}

/** The live record behind an integration's `Authorization` header, or null. */
function authorizedInternalCapability(header: string | string[] | undefined): InternalCapability | null {
  const got = Buffer.from(Array.isArray(header) ? "" : (header ?? ""));
  for (const [token, capability] of internalCapabilities) {
    if (!internalCapabilityIsActive(capability)) {
      internalCapabilities.delete(token);
      continue;
    }
    const expected = Buffer.from(`Bearer ${token}`);
    if (got.length === expected.length && timingSafeEqual(got, expected)) return capability;
  }
  return null;
}

function revokeInternalCapabilityGeneration(threadId: string, generation: string): void {
  for (const [token, capability] of internalCapabilities) {
    if (capability.threadId === threadId && capability.generation === generation) {
      internalCapabilities.delete(token);
    }
  }
  if (activeInternalGenerationByThread.get(threadId) === generation) {
    activeInternalGenerationByThread.delete(threadId);
  }
  internalGenerationByProviderTurn.deleteGeneration(threadId, generation);
}

/** Before a new turn on this thread mints: nothing an earlier turn here was
 * given stays honoured. The thread's bearers stay, so its engine stays warm. */
function revokeEarlierTurnCapabilities(threadId: string): void {
  computerSelectionTurns.delete(threadId);
  const generation = activeInternalGenerationByThread.get(threadId);
  if (generation) revokeInternalCapabilityGeneration(threadId, generation);
  // Defensive cleanup for any generation orphaned before exact ownership was
  // introduced. This force variant is used only by explicit stop/delete and
  // before a brand-new generation is published, never by a stale async catch.
  for (const [token, capability] of internalCapabilities) {
    if (capability.threadId === threadId) internalCapabilities.delete(token);
  }
}

/** Stop, a stall, a deleted bot or thread, a provider change: the thread's
 * bearers are retired too, so nothing that still holds one is honoured again. */
function revokeInternalCapabilitiesForThread(threadId: string): void {
  revokeEarlierTurnCapabilities(threadId);
  sessionCredentials.delete(threadId);
}

function revokeAllInternalCapabilities(): void {
  computerSelectionTurns.clear();
  internalCapabilities.clear();
  sessionCredentials.clear();
  activeInternalGenerationByThread.clear();
  internalGenerationByProviderTurn.clear();
}

function bindInternalCapabilityToProviderTurn(threadId: string, generation: string, turnId?: string): void {
  if (turnId && !internalGenerationByProviderTurn.bind(threadId, generation, turnId)) {
    revokeInternalCapabilityGeneration(threadId, generation);
  }
}

function revokeInternalCapabilityForProviderEvent(event: RuntimeEvent): void {
  if (!event.turnId) return;
  const owner = internalGenerationByProviderTurn.complete(event.threadId, event.turnId);
  if (!owner) return;
  revokeInternalCapabilityGeneration(owner.threadId, owner.generation);
}

  return {
    activeInternalGenerationByThread,
    authorizedInternalCapability,
    beginInternalCapabilityGeneration,
    internalCapabilityIsActive,
    bindInternalCapabilityToProviderTurn,
    computerSelectionTurns,
    mintInternalCapability,
    revokeAllInternalCapabilities,
    revokeEarlierTurnCapabilities,
    revokeInternalCapabilitiesForThread,
    revokeInternalCapabilityForProviderEvent,
    revokeInternalCapabilityGeneration,
  };
}
