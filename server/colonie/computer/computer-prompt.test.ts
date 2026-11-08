import { expect, test } from "vitest";
import { createComputerHost, type ContainerBackend } from "./computer-host.ts";
import { BOT_COMPUTER_PROMPT, botComputerMount } from "./computer-prompt.ts";

function running() {
  const backend: ContainerBackend = {
    facts: async () => ({ runtime: "docker", daemonUp: true, imageReady: true, container: "running", foreign: false, stale: false, viewerPort: 1, problem: null }),
    startRuntime: async () => {}, prepareImage: async () => {}, create: async () => {}, start: async () => {}, stop: async () => {}, remove: async () => {},
    exec: async () => "", mcp: (screen) => ({ command: "node", args: ["container-mcp.ts", "docker", "colonie-computer", `/run/user/1000/colonie-cua-${screen}.sock`, `:${screen}`], env: { ELECTRON_RUN_AS_NODE: "1" } }),
  };
  return createComputerHost({ backend, token: (() => { let n = 0; return () => `token${String(++n).padStart(20, "0")}`; })() });
}

test("a bot's screen is a computer tool server that needs no approval, and a bot with no screen has none", async () => {
  const host = running();
  expect(botComputerMount(host, "botA")).toBeUndefined();
  await host.screen("botA");
  await host.screen("botB");
  const a = botComputerMount(host, "botA")!;
  const b = botComputerMount(host, "botB")!;
  const stdio = (mount: typeof a) => mount.servers[0] as unknown as { name: string; command: string; args: string[] };
  expect(stdio(a)).toMatchObject({ name: "computer", command: "node" });
  expect(stdio(a).args.at(-1)).toBe(":2");
  expect(stdio(b).args.at(-1)).toBe(":3");
  expect(a.trustedServers).toEqual(["computer"]);
  expect(a.revision).not.toBe(b.revision);
});

test("the mount holds the computer once per turn and gives it back on deactivate or release", async () => {
  const host = running();
  await host.screen("botA");
  let held = 0;
  const realUse = host.use;
  host.use = () => { held++; const release = realUse(); return () => { held--; release(); }; };
  const mount = botComputerMount(host, "botA")!;
  mount.activate();
  mount.activate();
  expect(held).toBe(1);
  mount.deactivate();
  expect(held).toBe(0);
  mount.activate();
  expect(held).toBe(1);
  mount.release();
  mount.release();
  expect(held).toBe(0);
});

test("the bot is told how to drive its screen, including the measured scope advice", () => {
  expect(BOT_COMPUTER_PROMPT).toContain('scope "desktop"');
  expect(BOT_COMPUTER_PROMPT).toContain("bring_to_front");
  expect(BOT_COMPUTER_PROMPT).toContain("Computer tab");
  expect(BOT_COMPUTER_PROMPT).toMatch(/never ask for a password in chat/);
});
