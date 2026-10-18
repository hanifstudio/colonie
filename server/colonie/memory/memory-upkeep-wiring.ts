// Construction of the memory-upkeep pass (server/colonie/memory/memory-upkeep.ts):
// which bots may be captured, how a capture/organize/contradiction call reaches
// the model and books the tokens it spends, and how an "About me" suggestion is
// written back. `index.ts` supplies the shared collaborators — the store, the
// live registry, the config, the usage ledger and the learned-facts planner.
import { randomUUID } from "node:crypto";
import { isColonieAcpDriver } from "../../../shared/acp.ts";
import { captureQuietMs, DATA_DIR, loadConfig, saveConfig, tidyHour } from "../../config.ts";
import type { ProviderRegistry } from "../../harness/registry.ts";
import type { Store } from "../../persistence/store.ts";
import { appendAboutMe, type LearnedFacts } from "../../profile-learned.ts";
import { assertWithinBudget } from "../../spend.ts";
import { createMemoryUpkeep } from "./memory-upkeep.ts";
import { memoryDate, memorySourceLabel } from "../workspace/workspace.ts";

export interface MemoryUpkeepWiringDeps {
  // ponytail: one permissive shape instead of hand-typed lines for each name;
  // the two whose own shapes the callbacks read through are typed below.
  [name: string]: any;
  /** The learned-facts planner and the store whose callback shapes the
   * wiring reads through. */
  learnedFacts: LearnedFacts;
  registry: ProviderRegistry;
  store: Store;
}

export function createMemoryUpkeepWiring(deps: MemoryUpkeepWiringDeps) {
  const {
    botHasActiveTurn, bookTurnUsage, broadcast, cfg, configStatus, learnedFacts, registry, store
  } = deps;
  return createMemoryUpkeep({
    bots: () => store.bots.filter((bot) => !isColonieAcpDriver(registry.get(bot.modelSelection.instanceId)?.driverKind)),
    bot: (id) => store.bot(id) ?? undefined,
    engine: (botId) => {
      const bot = store.bot(botId);
      const instance = bot ? registry.get(bot.modelSelection.instanceId) : undefined;
      if (!bot || !instance || isColonieAcpDriver(instance.driverKind)) return null;
      const generate = instance.generateText?.bind(instance);
      return generate ? {
        generateText: async (prompt, options) => {
          // Check every capture, organize and contradiction call, including
          // consecutive calls within one upkeep pass.
          assertWithinBudget(cfg, DATA_DIR);
          const threadId = `memory-${randomUUID()}`;
          return generate(prompt, { ...options, onUsage: (usage) => bookTurnUsage({
            botId: bot.id,
            botName: bot.name,
            threadId,
            instanceId: instance.instanceId,
            driverKind: instance.driverKind,
            model: usage.model,
            input: usage.input ?? 0,
            output: usage.output ?? 0,
            ...(usage.cachedInput !== undefined ? { cachedInput: usage.cachedInput } : {}),
            costUsd: usage.costUsd ?? null,
            trigger: { kind: "bot", botId: bot.id },
          }, usage.input !== undefined && usage.output !== undefined, bot.threadId) });
        },
      } : {};
    },
    busy: (botId) => botHasActiveTurn(botId),
    addToAboutMe: (from, texts) => {
      const current = cfg.profile?.aboutMe ?? "";
      const facts = learnedFacts.plan(from, texts, current, memoryDate());
      const next = appendAboutMe(current, facts.map((fact) => fact.line));
      // a full About me takes nothing more; the person trims it first
      if (!facts.length || next === null) return 0;
      saveConfig({ profile: { ...cfg.profile, aboutMe: next } });
      Object.assign(cfg, loadConfig());
      learnedFacts.commit(facts);
      broadcast({ kind: "config", ...configStatus() });
      return facts.length;
    },
    sourceLabel: (botId, threadId) => memorySourceLabel({ task: store.taskByThread(botId, threadId), threadId }),
    quietMs: () => captureQuietMs(cfg),
    tidyHour: () => tidyHour(cfg),
    log: (line) => console.log(line),
  });
}
