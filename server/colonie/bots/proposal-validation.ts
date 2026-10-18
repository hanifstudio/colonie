// Validation shared by the bot-config proposal cards: driverCapabilitiesFor answers only from a live registry instance (a shadow or unknown one warns nothing), chiefPeerTargetRule lets a Chief of Staff target one section peer and everyone else only itself, and validateModelProposal re-checks that a proposed model resolves and that the destination driver still supports the bot's existing approval setup before a confirm can land.
import { type ModelSelection } from "../../contracts.ts";
import { type BotRecord } from "../../persistence/store.ts";
import { approvalModeFor } from "../../../shared/approval-mode.ts";
import { canReachPeer } from "../../colonie/peers/peer-roster.ts";

/** Everything this cluster reaches in the server; see the header. */
export interface ProposalValidationDeps {
  // ponytail: one permissive shape instead of hand-typed lines for each name;
  // tighten it when this cluster gets tests of its own.
  [name: string]: any;
}

export function createProposalValidation(deps: ProposalValidationDeps) {
  const {
    checkedModelSelection, registry, store, supportsApprovalMode
  } = deps;
/** Per-driver capability facts behind engine-switch warnings on proposal
 * cards. A live registry instance decides; a shadow or unknown instance
 * warns nothing rather than guessing from a stale catalog. */
const driverCapabilitiesFor = (instanceId: string) => {
  const instance = registry.get(instanceId);
  return instance ? { driverKind: instance.driverKind, agentsMcp: instance.adapter.capabilities.agentsMcp === true } : undefined;
};
/** A Chief may target one section peer; anyone else only itself. Shared by
 * profile and default-model proposals, and re-checked at confirm. */
const chiefPeerTargetRule = (noun: string) => (proposerBotId: string, targetBotId: string): string | null => {
  const proposer = store.bot(proposerBotId);
  const target = store.bot(targetBotId);
  if (!target) return "that bot no longer exists";
  if (!proposer?.chiefOfStaff) return "only a section's Chief of Staff can change another bot's " + noun;
  if (!canReachPeer(proposer, target)) return "that bot is not in a team this Chief is allowed to manage";
  return null;
};
/** Shared model validation for team-setup cards and propose_model: the
 * selection must resolve, and the destination driver must still support the
 * bot's existing approval setup. */
const validateModelProposal = (selection: ModelSelection, current?: BotRecord): string | null => {
  const checked = checkedModelSelection(selection, undefined, true);
  if (!checked.ok) return checked.error;
  if (current?.approvalGrant) return "Wait for the approval-level confirmation before changing this bot's model";
  if (current) {
    const mode = approvalModeFor(current);
    const driver = registry.cliTarget(selection.instanceId)?.driverKind;
    if (!supportsApprovalMode(selection, mode) || ((mode === "full" || mode === "custom") && driver !== registry.cliTarget(current.modelSelection.instanceId)?.driverKind)) {
      return `@${current.name}'s existing permissions are incompatible with that provider. Change its permissions in bot settings, then propose the model change again.`;
    }
  }
  return null;
};

  return {
    driverCapabilitiesFor,
    chiefPeerTargetRule,
    validateModelProposal,
  };
}
