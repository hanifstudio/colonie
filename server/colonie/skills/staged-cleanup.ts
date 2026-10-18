// Staged skill writes as the skill routes and thread deletion see them: stagedSkillListing exposes lifecycle metadata and never the staged instructions (the review copy lives only on the durable card), stagedSkillCleanupsForThread collects the (botId, stagedId) pairs a transcript's skill cards own before it is deleted (ownership from the server-authored sender, never the card payload), and rejectDeletedThreadSkillStages drops them so a name is never reserved for 30 days with no decision UI left.
import { listStagedSkillWrites, rejectStagedSkillWrite } from "../../colonie/skills/skills.ts";

/** Everything this cluster reaches in the server; see the header. */
export interface StagedSkillCleanupDeps {
  // ponytail: one permissive shape instead of hand-typed lines for each name;
  // tighten it when this cluster gets tests of its own.
  [name: string]: any;
}

export function createStagedSkillCleanup(deps: StagedSkillCleanupDeps) {
  const {
    store
  } = deps;
/** Listing endpoints expose lifecycle metadata, never the staged instructions
 * themselves. The exact review copy lives only on the durable approval card. */
function stagedSkillListing(staged: ReturnType<typeof listStagedSkillWrites>[number]) {
  const { files: _files, baseSha256: _baseSha256, baseAppliedStageId: _baseAppliedStageId, ...listing } = staged;
  return listing;
}

/** Capture proposal cleanup before a transcript is deleted. Staged writes
 * are bot-scoped and live outside the thread, so deleting the only card
 * without this would reserve its name for up to 30 days with no decision UI.
 * Ownership comes from the server-authored sender, never the card payload. */
function stagedSkillCleanupsForThread(threadId: string): Array<{ botId: string; stagedId: string }> {
  const directOwner = store.botByThread(threadId)?.id;
  const seen = new Set<string>();
  const cleanups: Array<{ botId: string; stagedId: string }> = [];
  for (const message of store.messagesFor(threadId)) {
    const request = message.card?.skillRequest;
    const botId = message.from?.botId ?? directOwner;
    if (!request || !botId) continue;
    const key = `${botId}:${request.stagedId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cleanups.push({ botId, stagedId: request.stagedId });
  }
  return cleanups;
}

function rejectDeletedThreadSkillStages(cleanups: Array<{ botId: string; stagedId: string }>): void {
  for (const cleanup of cleanups) rejectStagedSkillWrite(cleanup.botId, cleanup.stagedId);
}

  return {
    stagedSkillListing,
    stagedSkillCleanupsForThread,
    rejectDeletedThreadSkillStages,
  };
}
