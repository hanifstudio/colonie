// Booting the memory service and keeping it in step with bot lifecycle changes
// and settled turns.
//
// Memory is a feature, not a boot dependency: an unreadable ledger must not
// stop the app. When the store cannot load, memory is explicitly unavailable
// (recall/capture off, the panel says so) and the existing data is never
// written. The caller keeps the two bindings it hands to routes and subscribes
// the returned service; this module only builds it and wires its lifecycle.
import { AcpRuntime } from "../../acp/acp-runtime.ts";
import { contextPin } from "../../acp/context.ts";
import { inputReceipts } from "../../acp/receipts.ts";
import { isColonieAcpDriver } from "../../../shared/acp.ts";
import type { RuntimeEvent } from "../../contracts.ts";
import { DATA_DIR } from "../../config.ts";
import { assertWithinBudget } from "../../spend.ts";
import { ColonieMemoryService } from "./ledger/service.ts";
import { ColonieMemoryStore } from "./ledger/store.ts";

/** Everything this cluster reaches in the server; see the header. */
export interface ColonieMemoryBootDeps {
  // ponytail: one permissive shape instead of hand-typed lines for each name;
  // tighten it when this cluster gets tests of its own.
  [name: string]: any;
}

export function createColonieMemoryBoot(deps: ColonieMemoryBootDeps) {
  const {
    bus, cfg, colonieChief, colonieMemorySources, registry, shouldIgnoreProviderEvent, store
  } = deps;

let memoryStore: ColonieMemoryStore | null = null;
let memory: ColonieMemoryService;
try {
  memoryStore = new ColonieMemoryStore(DATA_DIR);
  memory = new ColonieMemoryService(memoryStore, {
    bot: (id) => {
      const bot = store.bot(id);
      const instance = bot && registry.get(bot.modelSelection.instanceId);
      return bot && instance && isColonieAcpDriver(instance.driverKind) ? bot : undefined;
    },
    owns: (botId, threadId) => {
      const pin = contextPin(threadId);
      return Boolean(store.taskByThread(botId, threadId) && pin?.snapshot.botId === botId
        && pin.snapshot.app.enabled && !pin.snapshot.legacyPlain);
    },
    analyze: async (botId, prompt, signal) => {
      const bot = store.bot(botId);
      const instance = bot && registry.get(bot.modelSelection.instanceId);
      if (!bot || !instance || !(instance.adapter instanceof AcpRuntime)) throw new Error("The selected provider cannot process memory right now.");
      assertWithinBudget(cfg, DATA_DIR);
      return instance.adapter.analyzeMemory(prompt, { model: bot.modelSelection.model, signal });
    },
    log: (message) => console.log(message),
  });
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  console.error(`Colonie memory is unavailable; the app continues without it and the stored data is left untouched: ${reason}`);
  const unavailable = { revision: "0", app: { enabled: false, automatic: false }, bot: { enabled: false, automatic: false }, entries: [],
    status: { pending: 0, running: false, lastError: "Stored memory could not be read; memory is unavailable until it is repaired. Your existing memory data was not changed." } };
  memory = {
    view: () => unavailable, snapshot: () => unavailable, recall: () => null, noteTurn: () => {}, start: () => {}, stop: async () => {},
    idle: async () => {}, cancelBot: () => {}, cancelThread: () => {}, cancelAll: () => {},
    updatePreferences: () => { throw Object.assign(new Error(unavailable.status.lastError), { status: 409 }); },
    saveEntry: () => { throw Object.assign(new Error(unavailable.status.lastError), { status: 409 }); },
    forgetEntry: () => { throw Object.assign(new Error(unavailable.status.lastError), { status: 409 }); },
    clear: () => { throw Object.assign(new Error(unavailable.status.lastError), { status: 409 }); },
  } as unknown as ColonieMemoryService;
}
store.onChange((change: { type: string; botId: string }) => {
  try { if (change.type === "bot.deleted") {
    memory.cancelBot(change.botId);
    memoryStore?.removeBot(change.botId);
    colonieChief.cancelBot(change.botId);
    for (const [threadId, source] of colonieMemorySources) if (source.botId === change.botId) colonieMemorySources.delete(threadId);
  } else if (change.type === "bot") {
    const bot = store.bot(change.botId);
    if (bot?.memoryEnabled === false || bot?.memoryUpkeep === false) memory.cancelBot(change.botId);
  } } catch { console.warn("Colonie memory could not persist this bot's memory lifecycle change."); }
});
bus.subscribe((event: RuntimeEvent) => {
  if (event.type !== "turn.completed" && event.type !== "session.exited") return;
  const source = colonieMemorySources.get(event.threadId);
  if (!source) return;
  colonieMemorySources.delete(event.threadId);
  if (event.type !== "turn.completed" || !event.ok || shouldIgnoreProviderEvent(event)) return;
  try {
    const receipt = inputReceipts(event.threadId).find((row) => row.turnId === event.turnId);
    if (receipt?.status !== "completed" || !receipt.context?.sections.some((section) => section.id === "app.identity" && section.status === "active")) return;
    const user = receipt.context.sections.find((section) => section.id === "user.message");
    if (user?.text !== source.text) return;
    memory.noteTurn(source);
  } catch { console.warn("Colonie memory could not queue this completed conversation."); }
});
return { memoryStore, memory };
}
