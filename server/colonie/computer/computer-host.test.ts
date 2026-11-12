import { expect, test } from "vitest";
import { ComputerFull, ComputerOff, createComputerHost, type ContainerBackend, type ContainerFacts } from "./computer-host.ts";
import { factsFromStatus } from "./container-backend.ts";

function fake(start: Partial<ContainerFacts> = {}) {
  const facts: ContainerFacts = { runtime: "docker", daemonUp: true, imageReady: true, container: "missing", foreign: false, stale: false, viewerPort: 32769, problem: null, ...start };
  const calls: string[] = [];
  let listing = "";
  const backend: ContainerBackend = {
    facts: async () => ({ ...facts }),
    startRuntime: async () => { calls.push("startRuntime"); facts.daemonUp = true; },
    prepareImage: async () => { calls.push("prepareImage"); facts.imageReady = true; },
    create: async () => { calls.push("create"); facts.container = "running"; },
    start: async () => { calls.push("start"); facts.container = "running"; },
    stop: async () => { calls.push("stop"); facts.container = "stopped"; },
    remove: async () => { calls.push("remove"); facts.container = "missing"; },
    exec: async (args) => {
      calls.push(`exec ${args.join(" ")}`);
      if (args[1] === "list") return listing;
      return "up";
    },
    mcp: (screen) => ({ command: "node", args: ["container-mcp.ts", "docker", "colonie-computer", `sock-${screen}`], env: {} }),
  };
  return { backend, facts, calls, setListing: (value: string) => { listing = value; } };
}
const tokens = () => { let n = 0; return () => `token${String(++n).padStart(20, "0")}`; };

test("a server that cannot run a computer says so and refuses to turn one on", async () => {
  const { backend } = fake();
  const host = createComputerHost({ backend, supported: () => false });
  expect((await host.view()).state).toBe("unsupported");
  await expect(host.turnOn()).rejects.toThrow(/cannot run a computer/);
});

test("without Docker or Podman the person is told what to install", async () => {
  const { backend } = fake({ runtime: null, daemonUp: false });
  const view = await createComputerHost({ backend }).view();
  expect(view.state).toBe("no-runtime");
  expect(view.message).toMatch(/Docker or Podman/);
});

test("turning on starts the runtime, prepares the image, makes the container, and shows the phases on the way", async () => {
  const { backend, calls } = fake({ daemonUp: false, imageReady: false });
  const seen: string[] = [];
  const host = createComputerHost({ backend });
  const original = backend.prepareImage;
  backend.prepareImage = async () => { seen.push((await host.view()).state); await original(); };
  await host.turnOn();
  expect(calls.filter((call) => !call.startsWith("exec"))).toEqual(["startRuntime", "prepareImage", "create"]);
  expect(seen).toEqual(["preparing"]);
  expect((await host.view()).state).toBe("on");
});

test("a stopped computer is started, not recreated; an old or unsafe one is replaced; a stranger's container is left alone", async () => {
  const stopped = fake({ container: "stopped" });
  await createComputerHost({ backend: stopped.backend }).turnOn();
  expect(stopped.calls.filter((call) => !call.startsWith("exec"))).toEqual(["start"]);

  const stale = fake({ container: "stopped", stale: true });
  await createComputerHost({ backend: stale.backend }).turnOn();
  expect(stale.calls.filter((call) => !call.startsWith("exec"))).toEqual(["remove", "create"]);

  const foreign = fake({ container: "stopped", foreign: true });
  const host = createComputerHost({ backend: foreign.backend });
  await expect(host.turnOn()).rejects.toThrow(/did not create/);
  expect(foreign.calls).toEqual([]);
  expect((await host.view()).message).toMatch(/did not create/);
});

test("each bot gets its own screen; the same bot gets the same one back; a full computer says so", async () => {
  const { backend, calls } = fake();
  const host = createComputerHost({ backend, token: tokens(), maxScreens: 2 });
  await expect(host.screen("botA")).rejects.toBeInstanceOf(ComputerOff);
  await host.turnOn();
  const a = await host.screen("botA");
  const b = await host.screen("botB");
  expect([a.number, b.number]).toEqual([2, 3]);
  expect(a.token).not.toBe(b.token);
  expect((await host.screen("botA")).token).toBe(a.token);
  expect(calls.filter((call) => call.includes("screen up"))).toHaveLength(2);
  expect(calls).toContain(`exec colonie-screen up 2 ${a.token} botA`);
  await expect(host.screen("botC")).rejects.toBeInstanceOf(ComputerFull);
  // a screen given back is free for the next bot
  await host.closeScreen("botA");
  expect(calls).toContain("exec colonie-screen down 2");
  expect((await host.screen("botC")).number).toBe(2);
  expect((await host.view()).screens.map((screen) => screen.botId).sort()).toEqual(["botB", "botC"]);
});

test("a failed screen start is not remembered", async () => {
  const { backend } = fake();
  const host = createComputerHost({ backend });
  await host.turnOn();
  const original = backend.exec;
  backend.exec = async (args) => { if (args[1] === "up") throw new Error("driver did not start"); return original(args); };
  await expect(host.screen("botA")).rejects.toThrow(/driver did not start/);
  expect(host.holds("botA")).toBe(false);
});

test("a restarted server finds the screens a running computer kept", async () => {
  const { backend, setListing } = fake({ container: "running" });
  setListing("2 botA tokAAAAAAAAAAAAAAAAAAAAAA\n3 botB tokBBBBBBBBBBBBBBBBBBBBBB\n4 - tokCCCCCCCCCCCCCCCCCCCCCC\n");
  const host = createComputerHost({ backend, token: tokens() });
  expect((await host.view()).screens.map((screen) => screen.botId)).toEqual(["botA", "botB"]);
  expect((await host.screen("botA")).token).toBe("tokAAAAAAAAAAAAAAAAAAAAAA");
  expect((await host.screen("botD")).number).toBe(4);
  expect(await host.viewer("botB")).toEqual({ port: 32769, token: "tokBBBBBBBBBBBBBBBBBBBBBB" });
  expect(host.mcp("botB")?.args.at(-1)).toBe("sock-3");
  expect(await host.viewer("nobody")).toBeNull();
});

test("it turns itself off when idle, waits while a turn uses it, and gives no viewer once off", async () => {
  const { backend, calls } = fake();
  let busy = true;
  const host = createComputerHost({ backend, idleMs: 40, busy: () => busy });
  await host.turnOn();
  await host.screen("botA");
  await new Promise((resolve) => setTimeout(resolve, 120));
  expect(calls).not.toContain("stop");
  busy = false;
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(calls).toContain("stop");
  expect((await host.view()).state).toBe("off");
  expect(await host.viewer("botA")).toBeNull();
  host.dispose();
});

test("only a hardened, loopback-only, durable computer of this image is kept", () => {
  const status = { runtime: "docker", daemonUp: true, image: true, container: "running", managed: true, imageMatches: true, security: "hardened", network: "loopback", persistence: "durable", viewer_port: 5, problem: null } as never;
  expect(factsFromStatus(status)).toMatchObject({ stale: false, foreign: false, viewerPort: 5 });
  for (const change of [{ imageMatches: false }, { security: "unsafe" }, { network: "unsafe" }, { persistence: "unsafe" }]) {
    expect(factsFromStatus({ ...(status as object), ...change } as never).stale).toBe(true);
  }
  expect(factsFromStatus({ ...(status as object), managed: false } as never)).toMatchObject({ foreign: true, stale: false });
  expect(factsFromStatus({ ...(status as object), container: "missing", managed: false } as never)).toMatchObject({ foreign: false, stale: false });
});

test("asking whether the computer is on does not ask the container runtime every time", async () => {
  const { backend } = fake({ container: "running" });
  let asked = 0;
  const original = backend.facts;
  backend.facts = async () => { asked++; return original(); };
  const host = createComputerHost({ backend });
  for (let turn = 0; turn < 20; turn++) await host.isOn();
  expect(asked).toBe(1);
  await host.turnOff();
  asked = 0;
  await host.isOn();
  expect(asked).toBe(1);
});

test("a turn holding the computer keeps it from turning itself off, and giving it back lets it", async () => {
  const { backend, calls } = fake();
  const host = createComputerHost({ backend, idleMs: 40 });
  await host.turnOn();
  const release = host.use();
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(calls).not.toContain("stop");
  release();
  release();
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(calls).toContain("stop");
  host.dispose();
});

test("taking over a screen refuses the bot's calls through its own key until it is handed back, for that screen only", async () => {
  const { backend } = fake({ container: "running" });
  const host = createComputerHost({ backend, token: tokens(), gateUrl: () => "http://127.0.0.1:8799/api/internal/computer-gate" });
  await host.screen("botA");
  await host.screen("botB");
  const key = (botId: string) => host.mcp(botId)!.env.COLONIE_CONTROL_TOKEN!;
  expect(host.mcp("botA")!.env.COLONIE_CONTROL_URL).toBe("http://127.0.0.1:8799/api/internal/computer-gate");
  // the key is not the viewer's secret
  expect(key("botA")).not.toBe("token00000000000000000001");
  expect(host.gate(key("botA"))).toEqual({ taken: false });
  host.takeOver("botA");
  expect(host.gate(key("botA"))).toEqual({ taken: true });
  expect(host.gate(key("botB"))).toEqual({ taken: false });
  expect((await host.view()).screens).toEqual([{ botId: "botA", taken: true }, { botId: "botB", taken: false }]);
  host.handBack("botA");
  expect(host.gate(key("botA"))).toEqual({ taken: false });
  expect(host.gate("not-a-key-not-a-key-not-a-key")).toBeUndefined();
});

test("a screen that is not open cannot be taken over, and closing it or turning off ends the hold", async () => {
  const { backend } = fake({ container: "running" });
  const host = createComputerHost({ backend, token: tokens() });
  expect(() => host.takeOver("botA")).toThrow(/not open/);
  await host.screen("botA");
  host.takeOver("botA");
  await host.closeScreen("botA");
  expect(host.taken("botA")).toBe(false);
  await host.screen("botA");
  host.takeOver("botA");
  await host.turnOff();
  expect(host.taken("botA")).toBe(false);
});
