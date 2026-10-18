// The per-turn integrations are what a turn's ACP session mounts, so the
// cases here pin the contract each one hands the adapter: the agent proxy env
// (including the capability flags derived from store/lending), the hook
// channel's loopback pair, the computer-control endpoint's per-turn bearer,
// and the capability mint itself.
import { expect, test } from "vitest";
import { createTurnIntegrations } from "./turn-integrations.ts";

const deps = (over: Record<string, unknown> = {}) => {
  const mints: Array<{ grant: any; options?: any }> = [];
  const integrations = createTurnIntegrations({
    PORT: 12345,
    activeInternalGenerationByThread: new Map(),
    botForThread: () => () => undefined,
    cfg: {},
    currentBrowserSession: () => () => "session",
    engineUnavailableLogged: () => false,
    lendingEnabled: () => true,
    mintInternalCapability: (grant: any, options?: any) => {
      mints.push({ grant, options });
      return `tok-${grant.kind}`;
    },
    setEngineUnavailableLogged: () => {},
    store: () => ({ bot: () => ({ memoryEnabled: true }) }),
    ...over,
  });
  return { integrations, mints };
};

test("the agent proxy env carries the turn's ids, depth and minted token", () => {
  const { integrations } = deps();
  const integration: any = integrations.agentsIntegration("b1", "t1", 3, true, "g1");
  expect(integration.command).toBe(process.execPath);
  expect(integration.env.COLONIE_HARNESS_URL).toBe("http://127.0.0.1:12345");
  expect(integration.env.COLONIE_BOT_ID).toBe("b1");
  expect(integration.env.COLONIE_THREAD_ID).toBe("t1");
  expect(integration.env.COLONIE_TURN_DEPTH).toBe("3");
  expect(integration.env.COLONIE_COMMS_TOKEN).toBe("tok-agents");
  expect(integration.env.COLONIE_SHARED_COMPUTERS_ENABLED).toBe("1");
});

test("the agent proxy disables memory when the bot does", () => {
  const { integrations } = deps({ store: () => ({ bot: () => ({ memoryEnabled: false }) }) });
  const integration: any = integrations.agentsIntegration("b1", "t1", 0, false, "g1");
  expect(integration.env.COLONIE_MEMORY_ENABLED).toBe("0");
});

test("the hook channel mints its own kind and returns the loopback pair", () => {
  const { integrations, mints } = deps();
  expect(integrations.hooksIntegration("b1", "t1", "g1")).toEqual({ url: "http://127.0.0.1:12345", token: "tok-hooks" });
  expect(mints[0]!.grant.kind).toBe("hooks");
});

test("computer control mints a per-turn bearer and encodes the bot id", () => {
  const { integrations, mints } = deps();
  const integration: any = integrations.controlIntegration("bot/1", "t1", "g1");
  expect(integration.url).toBe("http://127.0.0.1:12345/api/internal/computer-control?botId=bot%2F1");
  expect(mints[0]!.grant.kind).toBe("computer");
  expect(mints[0]!.options).toEqual({ perTurn: true });
});

test("the hook channel follows COLONIE_HOOKS", () => {
  const { integrations } = deps();
  const previous = process.env.COLONIE_HOOKS;
  try {
    process.env.COLONIE_HOOKS = "0";
    expect(integrations.hooksEnabled()).toBe(false);
    process.env.COLONIE_HOOKS = "1";
    expect(integrations.hooksEnabled()).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.COLONIE_HOOKS;
    else process.env.COLONIE_HOOKS = previous;
  }
});
