// The bot computer: one container for the workspace, one screen per bot. This
// module decides when it is on, who has which screen, and when it turns itself
// off. Every container command goes through a ContainerBackend, so all of it is
// tested without a container runtime; `containerBackend` is the real one.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ComputerView } from "../../../shared/computer.ts";
import { LocalVmIdleTimer } from "./local-vm-idle.ts";

export interface ContainerFacts {
  runtime: string | null;
  daemonUp: boolean;
  /** The prepared image for this version exists. */
  imageReady: boolean;
  container: "running" | "stopped" | "missing";
  /** A container exists under this name that Colonie did not make: never touched. */
  foreign: boolean;
  /** A container of ours that is from an older image layer, or not hardened: replaced. */
  stale: boolean;
  viewerPort: number | null;
  problem: string | null;
}

export interface ContainerBackend {
  facts(): Promise<ContainerFacts>;
  startRuntime(): Promise<void>;
  prepareImage(): Promise<void>;
  create(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  remove(): Promise<void>;
  /** Run a command inside the container as the desktop user; resolves to its output. */
  exec(args: string[], timeoutMs?: number): Promise<string>;
  /** The stdio command an engine runs to reach one screen's driver. */
  mcp(screen: number): { command: string; args: string[]; env: Record<string, string> };
}

export interface ComputerHostDeps {
  backend: ContainerBackend;
  /** False when this server cannot run a computer (a Shared workspace). */
  supported?: () => boolean;
  idleMs?: number;
  maxScreens?: number;
  /** A turn is using the computer right now: an idle stop waits. */
  busy?: () => boolean;
  token?: () => string;
  onChange?: () => void;
  /** Where a bot's screen tools ask whether the person is driving (the harness's own loopback URL). */
  gateUrl?: () => string | undefined;
}

export const DEFAULT_IDLE_MS = 30 * 60_000;
export const DEFAULT_MAX_SCREENS = 4;
const FIRST_SCREEN = 2;
const EXEC_MS = 30_000;

interface Held { number: number; token: string }

export class ComputerFull extends Error {
  readonly status = 409;
  constructor(max: number) { super(`All ${max} screens are in use. Turn one bot's computer work off, or try again in a moment.`); }
}
export class ComputerOff extends Error {
  readonly status = 409;
  constructor() { super("The computer is off. Turn it on first."); }
}

/** The key a screen's tools use to ask the harness: derived from the viewer token, never equal to it. */
const gateToken = (screenToken: string) => createHash("sha256").update(`colonie-gate:${screenToken}`).digest("base64url");
const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createComputerHost(deps: ComputerHostDeps) {
  const { backend } = deps;
  const idleMs = deps.idleMs ?? DEFAULT_IDLE_MS;
  const maxScreens = deps.maxScreens ?? DEFAULT_MAX_SCREENS;
  const makeToken = deps.token ?? (() => randomBytes(24).toString("base64url"));
  const supported = deps.supported ?? (() => true);
  const held = new Map<string, Held>();
  /** Bots whose screen the person is driving right now: the bot's tool calls are refused. */
  const taken = new Set<string>();
  let phase: "idle" | "preparing" | "starting" = "idle";
  let job: Promise<void> | null = null;
  let lastError: string | null = null;
  let recovered = false;
  let disposed = false;
  let cached: { at: number; facts: ContainerFacts } | null = null;
  /** Asking a container runtime costs several processes, and every bot turn asks:
   * an answer a few seconds old is enough (much older when there is no runtime at all). */
  async function facts(maxAgeMs: number): Promise<ContainerFacts> {
    const now = Date.now();
    if (cached && now - cached.at < (cached.facts.runtime ? maxAgeMs : Math.max(maxAgeMs, 30_000))) return cached.facts;
    const fresh = await backend.facts();
    cached = { at: Date.now(), facts: fresh };
    return fresh;
  }
  const forget = () => { cached = null; };

  let uses = 0;
  const idle = new LocalVmIdleTimer(idleMs, () => uses > 0 || (deps.busy?.() ?? false), async () => { await turnOff(); });
  const changed = () => deps.onChange?.();

  /** What a restarted server finds in a container that kept running. */
  async function recover(): Promise<void> {
    if (recovered) return;
    recovered = true;
    const out = await backend.exec(["colonie-screen", "list"], EXEC_MS).catch(() => "");
    for (const line of out.split("\n")) {
      const match = /^(\d+) (\S+) (\S+)$/.exec(line.trim());
      if (match && match[2] !== "-") held.set(match[2]!, { number: Number(match[1]), token: match[3]! });
    }
  }

  async function view(maxAgeMs = 1_500): Promise<ComputerView> {
    const base = { screens: [] as ComputerView["screens"], idleMinutes: Math.round(idleMs / 60_000) };
    if (!supported()) return { ...base, state: "unsupported", message: "This workspace's server cannot run a computer yet. Bots browse with the built-in browser here." };
    if (job) return { ...base, state: phase === "preparing" ? "preparing" : "starting", message: null };
    const known = await facts(maxAgeMs);
    if (!known.runtime) return { ...base, state: "no-runtime", message: "Colonie needs Docker or Podman to run a computer. Install one, then check again." };
    if (known.container !== "running" || !known.daemonUp) {
      held.clear(); taken.clear();
      recovered = false;
      // only a real failure is shown; "no computer made yet" is just off
      return { ...base, state: "off", message: lastError };
    }
    await recover();
    return { ...base, state: "on", message: null, screens: [...held.keys()].map((botId) => ({ botId, taken: taken.has(botId) })) };
  }

  async function bringUp(): Promise<void> {
    forget();
    let facts = await backend.facts();
    if (!facts.runtime) throw new Error("Colonie needs Docker or Podman to run a computer. Install one, then check again.");
    if (!facts.daemonUp) { phase = "starting"; changed(); await backend.startRuntime(); facts = await backend.facts(); }
    if (!facts.imageReady) { phase = "preparing"; changed(); await backend.prepareImage(); facts = await backend.facts(); }
    phase = "starting"; changed();
    if (facts.foreign) throw new Error("A container named colonie-computer exists that Colonie did not create. Remove it yourself, then try again.");
    if (facts.container !== "missing" && facts.stale) { await backend.remove(); facts = { ...facts, container: "missing" }; }
    if (facts.container === "missing") await backend.create();
    else if (facts.container === "stopped") await backend.start();
    // the container answers once its own list does
    let lastProblem = "";
    for (let attempt = 0; attempt < 60; attempt++) {
      try { await backend.exec(["colonie-screen", "list"], EXEC_MS); return; }
      catch (error) { lastProblem = error instanceof Error ? error.message : String(error); }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error(`The computer did not become ready: ${lastProblem}`);
  }

  function turnOn(): Promise<void> {
    if (disposed) return Promise.reject(new Error("shutting down"));
    if (!supported()) return Promise.reject(Object.assign(new Error("This server cannot run a computer"), { status: 409 }));
    if (job) return job;
    lastError = null;
    phase = "starting";
    job = bringUp().then(() => { forget(); idle.touch(); }, (error: unknown) => {
      lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }).finally(() => { job = null; phase = "idle"; changed(); });
    changed();
    return job;
  }

  async function turnOff(): Promise<void> {
    idle.cancel();
    held.clear(); taken.clear();
    recovered = false;
    forget();
    const now = await backend.facts();
    if (now.container === "running") await backend.stop();
    forget();
    changed();
  }

  async function isOn(): Promise<boolean> {
    if (!supported() || job) return false;
    return (await facts(5_000)).container === "running";
  }

  /** The bot's screen, started if it has none yet. */
  async function screen(botId: string): Promise<{ number: number; token: string }> {
    if (!/^[\w-]{1,80}$/.test(botId)) throw Object.assign(new Error("bad bot id"), { status: 400 });
    if (!(await isOn())) throw new ComputerOff();
    await recover();
    const existing = held.get(botId);
    if (existing) { idle.touch(); return existing; }
    const used = new Set([...held.values()].map((entry) => entry.number));
    let number = FIRST_SCREEN;
    while (used.has(number)) number++;
    if (number >= FIRST_SCREEN + maxScreens) throw new ComputerFull(maxScreens);
    const entry = { number, token: makeToken() };
    held.set(botId, entry);
    try {
      await backend.exec(["colonie-screen", "up", String(number), entry.token, botId], 90_000);
    } catch (error) {
      held.delete(botId);
      throw error;
    }
    idle.touch();
    changed();
    return entry;
  }

  async function closeScreen(botId: string): Promise<void> {
    const entry = held.get(botId);
    if (!entry) return;
    held.delete(botId); taken.delete(botId);
    await backend.exec(["colonie-screen", "down", String(entry.number)], EXEC_MS).catch(() => undefined);
    changed();
  }

  return {
    view, turnOn, turnOff, isOn, screen, closeScreen,
    /** Where the viewer for this bot's screen is reached inside the container. */
    async viewer(botId: string): Promise<{ port: number; token: string } | null> {
      const entry = held.get(botId);
      const now = await facts(5_000);
      if (!entry || now.container !== "running" || !now.viewerPort) return null;
      return { port: now.viewerPort, token: entry.token };
    },
    mcp: (botId: string) => {
      const entry = held.get(botId);
      if (!entry) return null;
      const spec = backend.mcp(entry.number);
      const url = deps.gateUrl?.();
      // the screen's tools ask before every call, and refuse while the person is driving
      return url ? { ...spec, env: { ...spec.env, COLONIE_CONTROL_URL: url, COLONIE_CONTROL_TOKEN: gateToken(entry.token) } } : spec;
    },
    holds: (botId: string) => held.has(botId),
    /** The person drives this screen: the bot's tool calls are refused until handBack. */
    takeOver(botId: string): void {
      if (!held.has(botId)) throw Object.assign(new Error("This screen is not open."), { status: 409 });
      if (!taken.has(botId)) { taken.add(botId); idle.touch(); changed(); }
    },
    handBack(botId: string): void { if (taken.delete(botId)) { idle.touch(); changed(); } },
    taken: (botId: string) => taken.has(botId),
    /** Whether the person is driving the screen that this gate token belongs to; undefined for a stranger's token. */
    gate(token: string): { taken: boolean } | undefined {
      for (const [botId, entry] of held) if (safeEqual(gateToken(entry.token), token)) return { taken: taken.has(botId) };
      return undefined;
    },
    /** A turn is working on the computer: it will not turn itself off until released. */
    use: (): (() => void) => { uses++; idle.touch(); let done = false; return () => { if (!done) { done = true; uses--; idle.touch(); } }; },
    touch: () => { if (held.size || job === null) idle.touch(); },
    dispose: () => { disposed = true; idle.cancel(); },
  };
}

export type ComputerHost = ReturnType<typeof createComputerHost>;
