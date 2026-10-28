// The computer bridge's control channel (control-client.ts), restored after
// the dead internal transport went (cabf4c03) and took this live route with
// it: every Local VM action asks here first, and an unanswered ask fails
// closed, so without it a bot's desktop refused every click.
//
// GET answers whether the bot may act now: a person holding its computer, a
// lazily attached desktop whose claim has not landed, or another thread on
// the same computer all refuse. POST is the bot asking the person to take
// over; DELETE withdraws an ask nobody answered.
import type { IncomingMessage } from "node:http";

import { lazyClaimWaitMs, startAutoVmClaim, type AutoVmClaimTable } from "../colonie/computer/auto-vm-claims.ts";
import type { TurnOwner } from "../colonie/chat/turn-resources.ts";
import { PASS, type RouteHandler } from "./table.ts";

/** How long the gate lets a lazy claim land before it answers held. A free,
 * ready VM claims in the time of one container inspect; only a claim queued
 * behind another holder outlives this. */
export const LAZY_VM_CLAIM_GRACE_MS = 5_000;

interface Capability { botId: string; threadId: string; generation: string; kind: string }
type Snapshot = { held: boolean; helpReason: string | null };
export type ComputerGate = { held: boolean; helpOpen: boolean; blockedReason?: string };

const OTHER_THREAD = "Another thread is using this computer. This call was not performed. Pause computer work until that thread finishes, then take a fresh screenshot before acting.";

export async function computerCallGate(capability: Capability, deps: {
  snapshot: (botId: string) => Snapshot;
  autoVmClaims: AutoVmClaimTable;
  turnComputerResources: Map<string, { owner: TurnOwner; resource: string }>;
  claimTurnResource: (owner: TurnOwner, resource: string) => boolean;
  graceMs?: number;
}): Promise<ComputerGate> {
  const snapshot = deps.snapshot(capability.botId);
  const slot = deps.autoVmClaims.get(capability.threadId);
  const lazyClaim = slot && slot.owner.generation === capability.generation ? slot : undefined;
  const waitMs = snapshot.held ? null : lazyClaimWaitMs(lazyClaim, deps.graceMs ?? LAZY_VM_CLAIM_GRACE_MS);
  if (lazyClaim && waitMs !== null) {
    // The first screen call on a lazily attached computer fires its
    // exclusive claim, once, and gives it a moment to land.
    startAutoVmClaim(deps.autoVmClaims, capability.threadId, capability.generation);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      lazyClaim.begin ?? Promise.resolve(),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); }),
    ]);
    clearTimeout(timer);
  }
  if (!snapshot.held && lazyClaim?.failed === true) {
    // A rejected claim leaves this turn without a usable computer: refuse
    // every screen call for the rest of the turn, and say not to retry.
    return {
      held: true, helpOpen: false,
      blockedReason: `This turn could not claim ${lazyClaim.label ?? "this computer"}${lazyClaim.failure ? ` (${lazyClaim.failure})` : ""}. This call was not performed. Do not retry computer work in this turn; tell the person what you could not do.`,
    };
  }
  if (!snapshot.held && lazyClaim?.lazy && lazyClaim.begin && !lazyClaim.claimed) {
    return { held: true, helpOpen: false, blockedReason: lazyClaim.pendingReason ?? OTHER_THREAD };
  }
  const computer = deps.turnComputerResources.get(capability.threadId);
  if (!snapshot.held && computer && computer.owner.generation === capability.generation &&
      !deps.claimTurnResource(computer.owner, computer.resource)) {
    return { held: true, helpOpen: false, blockedReason: OTHER_THREAD };
  }
  return { held: snapshot.held, helpOpen: snapshot.helpReason !== null };
}

export function createInternalComputerControlRoute(deps: Parameters<typeof computerCallGate>[1] & {
  authorize: (header: IncomingMessage["headers"]["authorization"]) => Capability | null;
  isActive: (capability: Capability) => boolean;
  bot: (id: string) => { id: string } | undefined;
  /** The bot asks the person to take over: the app shows it and buzzes. */
  requestHelp: (botId: string, threadId: string, reason: unknown) => { held: boolean; helpOpen: boolean; requestId: string };
  expireHelp: (botId: string, requestId: unknown) => { held: boolean; helpOpen: boolean };
  /** The bot is acting on its computer: the app may open its panel. */
  announce?: (capability: Capability) => void;
}): RouteHandler {
  return async ({ req, res, url, path, method, json, readBody }) => {
    if (path !== "/api/internal/computer-control") return PASS;
    const capability = deps.authorize(req.headers.authorization);
    if (!capability || !deps.bot(capability.botId)) return json(res, 401, { error: "unauthorized" });
    if (capability.kind !== "computer") return json(res, 403, { error: "this internal capability cannot access that service" });
    const claimed = url.searchParams.get("botId");
    if (claimed !== null && claimed !== capability.botId) return json(res, 403, { error: "the internal capability belongs to a different bot" });
    if (!deps.isActive(capability)) return json(res, 401, { error: "the internal turn capability has expired" });
    if (method === "GET") {
      const gate = await computerCallGate(capability, deps);
      if (!gate.held) deps.announce?.(capability);
      return json(res, 200, gate);
    }
    if (method !== "POST" && method !== "DELETE") return json(res, 405, { error: "method not allowed" });
    const body = (await readBody(req)) ?? {};
    // Authorization at header time is not a lease: a turn that settled while
    // the body was in flight must not open or close anything.
    if (!deps.isActive(capability)) return json(res, 401, { error: "the internal turn capability has expired" });
    if ((body.botId !== undefined && String(body.botId) !== capability.botId) || (body.threadId !== undefined && String(body.threadId) !== capability.threadId)) {
      return json(res, 403, { error: "the internal capability belongs to a different conversation" });
    }
    if (method === "POST") return json(res, 200, deps.requestHelp(capability.botId, capability.threadId, body.reason));
    return json(res, 200, deps.expireHelp(capability.botId, body.requestId));
  };
}
