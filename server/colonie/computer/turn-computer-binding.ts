// Waiting for, and binding, one turn's computer seat: the claim loop with its one place per resource, the transcript's waiting chip and its resolution line, the turn.wait_started/turn.wait_ended events, and the two ways the wait ends without the seat — a cancelled setup, or the ceiling that parks the turn (ADR-2, #1651). Every computer claim in the server passes through here.
import { type TurnOwner } from "../../colonie/chat/turn-resources.ts";
import { type Message } from "../../persistence/store.ts";
import { computerFreeAfterText, computerParkedText, computerStoppedWaitingText, computerWaitingText, type ComputerHolder } from "../../colonie/computer/computer-wait.ts";
import { newId } from "../../contracts.ts";

/** Everything this cluster reaches in the server; see the header. */
export interface TurnComputerBindingDeps {
  // ponytail: one permissive shape instead of hand-typed lines for each name;
  // tighten it when this cluster gets tests of its own.
  [name: string]: any;
}

export function createTurnComputerBinding(deps: TurnComputerBindingDeps) {
  const {
    COMPUTER_WAIT_MAX_MS, ComputerWaitParked, DirectTurnSetupCancelled,
    activeInternalGenerationByThread, bus, claimTurnResource, registry, store,
    turnComputerResources, turnResourceOwners, turnResources
  } = deps;

async function bindTurnComputer(owner: TurnOwner, resource: string, exclusive = false): Promise<void> {
  // Every computer claim passes here.
  const active = () => activeInternalGenerationByThread.get(owner.threadId) === owner.generation &&
    turnResourceOwners.get(owner.threadId)?.generation === owner.generation;
  let waitingMessage: Message | undefined;
  // Who holds the desktop, as the chip and the give-up error name them: a
  // bot running a titled thread, or a room. Read once, when the wait begins.
  let holder: ComputerHolder | undefined;
  let holderThreadRef: { botId: string; threadId: string; title: string } | undefined;
  const deadline = Date.now() + COMPUTER_WAIT_MAX_MS();
  // The wait is history the transcript keeps (#1647): the waiting chip stays
  // exactly as written, a resolution line is appended beside it, and the
  // turn.wait_* events carry the same facts for the inspector log.
  let waitedSince: number | undefined;
  let waitEnded = false;
  const waitEventBase = () => {
    const selection = store().botByThread(owner.threadId)?.modelSelection;
    const instance = selection ? registry.get(selection.instanceId) : null;
    return {
      eventId: newId(),
      provider: instance?.driverKind ?? "harness",
      ...(instance && selection ? { providerInstanceId: selection.instanceId } : {}),
      threadId: owner.threadId,
      createdAt: new Date().toISOString(),
    };
  };
  const endWait = (outcome: "acquired" | "parked" | "stopped") => {
    if (!waitingMessage || waitEnded) return;
    waitEnded = true;
    const waitedMs = waitedSince === undefined ? 0 : Date.now() - waitedSince;
    // Acquisition is the only wait that completes: it is the sample the
    // per-resource estimate is built from (#1652).
    if (outcome === "acquired") turnResources.noteWait(resource, waitedMs);
    const text = outcome === "acquired"
      ? computerFreeAfterText(holder, waitedMs)
      : outcome === "parked"
        ? computerParkedText(holder, COMPUTER_WAIT_MAX_MS())
        : computerStoppedWaitingText(holder, waitedMs);
    store().appendMessage(owner.threadId, {
      role: "bot", kind: "activity",
      tool: { name: text, ok: true },
      ...(holderThreadRef ? { threadRef: holderThreadRef } : {}),
    });
    bus.publish({
      ...waitEventBase(),
      type: "turn.wait_ended",
      resource,
      ...(holder ? { holder } : {}),
      waitedMs,
      outcome,
    });
  };
  try {
    while (true) {
      if (!active()) throw new DirectTurnSetupCancelled("Computer wait cancelled");
      if (!exclusive || claimTurnResource(owner, resource)) break;
      if (!waitingMessage) {
        // Arrival in the waitlist is the chip's timestamp: the position it
        // reads is where this turn sits the moment it starts waiting (#1652).
        const position = turnResources.startWaiting(resource, owner);
        const estimateMs = turnResources.waitEstimateMs(resource);
        const blocker = turnResources.blocker(resource, owner);
        const holderBot = blocker && store().botByThread(blocker.threadId);
        const holderTask = holderBot && blocker && store().taskByThread(holderBot.id, blocker.threadId);
        holder = holderBot
          ? { name: holderBot.name, ...(holderTask?.title ? { task: holderTask.title } : {}) }
          : undefined;
        holderThreadRef = holderBot && holderTask?.title
          ? { botId: holderBot.id, threadId: holderTask.threadId, title: holderTask.title }
          : undefined;
        waitingMessage = store().appendMessage(owner.threadId, {
          role: "bot", kind: "activity",
          tool: { name: computerWaitingText(holder, { position, estimateMs }) },
          ...(holderThreadRef ? { threadRef: holderThreadRef } : {}),
        });
        waitedSince = Date.now();
        bus.publish({
          ...waitEventBase(),
          type: "turn.wait_started",
          resource,
          position,
          ...(holder ? { holder } : {}),
        });
      }
      if (Date.now() >= deadline) {
        // ADR-2 (#1651): the ceiling parks the turn — settled, with a
        // registered resume — instead of failing it. The owner mark lets the
        // live lazy-claim rejection path park the same way.
        endWait("parked");
        owner.computerParkedOn = resource;
        throw new ComputerWaitParked(computerParkedText(holder, COMPUTER_WAIT_MAX_MS()), resource, owner.generation);
      }
      await new Promise<void>(resolve => setTimeout(resolve, 100));
    }
  } finally {
    // Never patch the waiting chip over: the queue position this turn held
    // stays visible beside what the wait came to.
    endWait(active() && turnResources.owns(resource, owner) ? "acquired" : "stopped");
    // Whatever the wait came to, this turn is no longer waiting: an owner
    // left at the front would block the grant for everyone behind it.
    turnResources.stopWaiting(resource, owner);
  }
  turnResourceOwners.set(owner.threadId, owner);
  turnComputerResources.set(owner.threadId, { owner, resource });
}

  return {
    bindTurnComputer,
  };
}
