// createProcessLifecycle is the server's own lifecycle: what runs once the
// listener is up and what a signal tears down before the process exits. The
// cases here pin the observable skeleton — the loopback bind, the signal
// wiring, the boot drain/starters, and a shutdown that exits 0 (or 1 when the
// session marker cannot be cleared).
import { afterEach, expect, test, vi } from "vitest";
import { createProcessLifecycle, type ProcessLifecycleDeps } from "./process-lifecycle.ts";

const PORT = 12345;

function harness(over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const followups: boolean[] = [];
  const shutting: boolean[] = [];
  const signals: Array<[string, () => void]> = [];
  let listen: { port: number; host: string; cb: () => Promise<void> } | undefined;

  vi.spyOn(process, "on").mockImplementation(((signal: string, fn: () => void) => {
    signals.push([signal, fn]);
    return process;
  }) as never);
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    calls.push(`exit:${code}`);
    return undefined as never;
  }) as never);
  // The boot drain arms an interval; keep it inert and out of the real loop.
  vi.spyOn(globalThis, "setInterval").mockReturnValue({ unref: () => {} } as never);

  const deps: ProcessLifecycleDeps = {
    DELEGATION_SWEEP_MS: 1_000_000_000,
    PORT,
    browserLive: { closeAll: () => calls.push("browserLive.closeAll") },
    browserRuntime: { closeAll: async () => { calls.push("browserRuntime.closeAll"); } },
    bus: { flush: () => calls.push("bus.flush") },
    calendarCalls: () => ({ stop: () => calls.push("calendarCalls.stop") }),
    colonieChief: { dispose: () => calls.push("colonieChief.dispose") },
    colonieMemory: () => ({
      start: () => calls.push("colonieMemory.start"),
      stop: () => calls.push("colonieMemory.stop"),
      idle: async () => { calls.push("colonieMemory.idle"); },
    }),
    commsBus: {},
    connectedTools: { dispose: () => calls.push("connectedTools.dispose") },
    desktopViewer: { closeAll: () => calls.push("desktopViewer.closeAll") },
    drainQueuedSends: () => calls.push("drainQueuedSends"),
    drainThreadDelegations: (threadId: string) => calls.push(`drainThreadDelegations:${threadId}`),
    enginesRead: () => null,
    expireDelegationsNow: () => calls.push("expireDelegationsNow"),
    forgetTemporaryBrowser: async (botId: string) => { calls.push(`forget:${botId}`); },
    liveCalls: { shutdown: () => calls.push("liveCalls.shutdown") },
    localVmIdles: new Map<string, unknown>([["a", { cancel: () => calls.push("idle.cancel") }]]),
    mcpOAuth: { dispose: () => calls.push("mcpOAuth.dispose") },
    memoryUpkeep: { start: () => calls.push("memoryUpkeep.start"), stop: () => calls.push("memoryUpkeep.stop") },
    registry: { disposeAll: async () => { calls.push("registry.disposeAll"); } },
    releaseDataDirLeaseAtExit: () => calls.push("releaseLease"),
    revokeAllInternalCapabilities: () => calls.push("revokeAll"),
    routines: () => ({
      start: () => calls.push("routines.start"),
      stop: () => calls.push("routines.stop"),
      runForThread: () => undefined,
    }),
    server: {
      listen: (port: number, host: string, cb: () => Promise<void>) => {
        listen = { port, host, cb };
        return {};
      },
    },
    sessions: { close: () => calls.push("sessions.close") },
    setFollowupsReady: (value: boolean) => followups.push(value),
    setShuttingDown: (value: boolean) => shutting.push(value),
    sharedComputerControl: { close: () => calls.push("sharedComputerControl.close") },
    sharedComputers: { close: () => calls.push("sharedComputers.close") },
    shuttingDown: () => false,
    store: { botByThread: () => undefined, activePath: () => [] },
    temporaryBrowserSessions: new Map<string, string>([["b1", "guest-1"]]),
    watchdog: { stop: () => calls.push("watchdog.stop") },
    webhookIngress: () => null,
    workspaceAccessTimer: null,
    ...over,
  };
  createProcessLifecycle(deps);
  return { calls, followups, shutting, signals, listen: () => listen };
}

afterEach(() => vi.restoreAllMocks());

test("the listener is bound on loopback and both signals are wired", () => {
  const { listen, signals } = harness();
  expect(listen()).toMatchObject({ port: PORT, host: "127.0.0.1" });
  expect(signals.map(([signal]) => signal)).toEqual(["SIGINT", "SIGTERM"]);
});

test("once the listener is up the queues drain and the presenters start", async () => {
  const { listen, calls, followups } = harness();
  await listen()!.cb();
  expect(followups).toEqual([true]);
  expect(calls).toEqual(expect.arrayContaining([
    "drainQueuedSends", "routines.start", "memoryUpkeep.start", "colonieMemory.start",
  ]));
  // Nothing left over from a previous run: no delegation drain.
  expect(calls.filter((call) => call.startsWith("drainThreadDelegations"))).toEqual([]);
});

test("a signal tears the server down in order and exits 0", async () => {
  const { listen, signals, calls, followups, shutting } = harness();
  await listen()!.cb();
  signals.find(([signal]) => signal === "SIGINT")![1]();
  await vi.waitFor(() => expect(calls).toContain("exit:0"));
  expect(followups).toEqual([true, false]);
  expect(shutting).toEqual([true]);
  for (const step of [
    "revokeAll", "browserLive.closeAll",
    "watchdog.stop", "routines.stop", "memoryUpkeep.stop",
    "colonieMemory.stop", "colonieChief.dispose", "registry.disposeAll", "forget:b1",
    "browserRuntime.closeAll", "liveCalls.shutdown", "colonieMemory.idle", "sessions.close",
    "bus.flush", "mcpOAuth.dispose", "connectedTools.dispose", "releaseLease",
  ]) {
    expect(calls, step).toContain(step);
  }
  for (const retired of ["sharedComputers.close", "sharedComputerControl.close", "desktopViewer.closeAll", "idle.cancel"]) {
    expect(calls, retired).not.toContain(retired);
  }
});

test("it is idempotent: a second signal does not tear down twice", async () => {
  const { listen, signals, calls } = harness();
  await listen()!.cb();
  const handler = signals.find(([signal]) => signal === "SIGINT")![1];
  handler();
  await vi.waitFor(() => expect(calls).toContain("exit:0"));
  handler();
  await Promise.resolve();
  expect(calls.filter((call) => call === "exit:0")).toHaveLength(1);
});

test("a failed session close still exits, with code 1", async () => {
  const { listen, signals, calls } = harness({
    sessions: { close: () => { throw new Error("disk full"); } },
  });
  await listen()!.cb();
  signals.find(([signal]) => signal === "SIGTERM")![1]();
  await vi.waitFor(() => expect(calls).toContain("exit:1"));
});
