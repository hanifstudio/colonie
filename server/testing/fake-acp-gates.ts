// Test side of fake-acp-cli.ts's FAKE_ACP_GATE_DIR: see which ACP turns are
// held, and release one by key (or all). The fake writes the same file names
// itself, inline, because it must stay dependency-free.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** What a held turn records in `<dir>/<key>.waiting.json`. `text` is every
 * text block of the prompt joined, so a test can find its own message. */
export type FakeAcpGate = { key: string; pid: number; sessionId: string | null; cwd: string; turn: number; at: number; text: string };
export type FakeAcpGateEvent = { event: "waiting" | "released" | "cancelled"; key: string; pid: number; at: number };

/** The marker the fake keys a turn by unless FAKE_ACP_GATE_MARKER overrides it. */
export const gateMarker = (key: string) => `[gate:${key}]`;

export function waitingGates(dir: string): FakeAcpGate[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".waiting.json")).flatMap((name) => {
    // a turn released mid-read has already removed its file
    try { return [JSON.parse(readFileSync(join(dir, name), "utf8")) as FakeAcpGate]; } catch { return []; }
  }).sort((a, b) => a.at - b.at);
}

export function gateEvents(dir: string): FakeAcpGateEvent[] {
  const file = join(dir, "events.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as FakeAcpGateEvent);
}

/** Let the turn held under `key` run; the release stays in place, so a later
 * turn with the same key is not held. */
export function releaseGate(dir: string, key: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${key}.release`), "release");
}

/** Release every held and future turn, e.g. before teardown. */
export function releaseAllGates(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "all.release"), "release");
}

/** Poll until `ready` accepts the held turns, failing after `timeoutMs`. */
export async function waitForGates(dir: string, ready: (gates: FakeAcpGate[]) => boolean, timeoutMs = 10_000): Promise<FakeAcpGate[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const gates = waitingGates(dir);
    if (ready(gates)) return gates;
    if (Date.now() > deadline) throw new Error(`Fake ACP gates not ready after ${timeoutMs}ms: ${JSON.stringify(gates.map((gate) => gate.key))}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
