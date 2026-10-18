// Which approval level a turn actually runs at: approvalModeForTurn falls back to Ask whenever the selected provider has no mapping for an elevated level, sourceApprovalMode reads the level of the conversation that asked (never a sibling's or a future conversation's), fullAccessForSource answers whether that conversation is Full, and appliesDirectly says whether a bot's routine/skill/profile/model change may be applied without a person, as one state of server/direct-apply.ts.
import { type BotRecord } from "../persistence/store.ts";
import { approvalModeFor, type ApprovalMode} from "../../shared/approval-mode.ts";
import { approvalModeForOrigin } from "../auto-approve.ts";
import { directApply, type DirectApply} from "../direct-apply.ts";

/** Everything this cluster reaches in the server; see the header. */
export interface ApprovalResolutionDeps {
  // ponytail: one permissive shape instead of hand-typed lines for each name;
  // tighten it when this cluster gets tests of its own.
  [name: string]: any;
}

export function createApprovalResolution(deps: ApprovalResolutionDeps) {
  const {
    connectorThread, store, supportsApprovalMode
  } = deps;
/** Defense in depth for hand-edited/corrupt durable records: elevated
 * approval semantics require an implemented provider mapping. The trusted transition enforces
 * this too, but no provider dispatch or later permission callback relies on
 * persistence having been produced exclusively by that route. Delegation
 * uses the receiving bot's grant, never the sender's (approvalModeForOrigin) —
 * with one deliberate exception: a Chief of Staff's level flows down to the
 * threads it delegates (delegatedLevel), so the level the person gave the
 * Chief covers the work the Chief hands out. */
const approvalModeForTurn = (bot: BotRecord, peerInitiated = false): ApprovalMode => {
  const mode = approvalModeForOrigin(approvalModeFor(bot), { peerInitiated });
  if (!supportsApprovalMode(bot.modelSelection, mode)) {
    return "ask";
  }
  return mode;
};

/** A level belongs to the requesting conversation, not whichever sibling is
 * selected in the UI or the bot's default for future conversations. */
function sourceApprovalMode(botId: string, threadId: string): ApprovalMode {
  const owner = connectorThread()(botId, threadId);
  if (!owner) return "ask";
  const bot = store.projectBotForTask(botId, threadId) ?? owner.bot;
  // Origin changes Custom to Auto, never Full; no live-turn state is needed.
  return approvalModeForTurn(bot, false);
}

function fullAccessForSource(botId: string, threadId: string): boolean {
  return sourceApprovalMode(botId, threadId) === "full";
}

/** Whether a bot's routine, skill, profile or model change applies without
 * a person, and why: Full access applies everything as it always has, and
 * at any level a change to the bot itself applies, shown as a one-line
 * receipt with Undo (server/direct-apply.ts). Team setup and peer approvals
 * stay Full access only (fullAccessForSource). */
function appliesDirectly(botId: string, threadId: string, targetBotId: string): DirectApply | null {
  return directApply({
    fullAccess: fullAccessForSource(botId, threadId),
    botId,
    targetBotId,
    blocked: !connectorThread()(botId, threadId),
  });
}

  return {
    approvalModeForTurn,
    sourceApprovalMode,
    fullAccessForSource,
    appliesDirectly,
  };
}
