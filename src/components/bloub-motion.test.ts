// The rule behind a bot staying recognizable: while the bot is "there" it keeps the body its owner
// chose and its eyes stay inside it; only a state that turns the bot into something else may lose it.
import { expect, test } from "vitest";
import { BotEngine, type RenderedEye } from "../../third_party/bloub/src/bot/engine";
import { EXPRESSIONS } from "../../third_party/bloub/src/bot/expressions";
import { STATE_BY_ID, type StateId } from "../../third_party/bloub/src/bot/states";
import { MAUS_STATES, type MausMotion } from "@/lib/mascot";
import { PICKABLE_BODY_IDS, bloubShape, bloubState } from "./BloubAvatar";
import { MOTION_MOTION, STATE_MOTION, motionFor } from "./bloub-motion";

test("every state a bot can be in is listed, and none that does not exist", () => {
  expect(Object.keys(STATE_MOTION).sort()).toEqual([...MAUS_STATES].sort());
  for (const { engine } of [...Object.values(STATE_MOTION), ...Object.values(MOTION_MOTION)]) expect(STATE_BY_ID.has(engine), engine).toBe(true);
});

test("a state that shows the bot lets the owner's body replace the engine's, and one that transforms it does not", () => {
  for (const [name, { engine, look }] of [...Object.entries(STATE_MOTION), ...Object.entries(MOTION_MOTION as Record<string, never>)] as Array<[string, { engine: StateId; look: string }]>) {
    expect(STATE_BY_ID.get(engine)!.baseBody, `${name} plays ${engine}`).toBe(look === "bot");
  }
});

test("a bot at work keeps its body from the first frame to the last, for every body", () => {
  expect(motionFor("working")).toEqual({ engine: "rings", look: "bot" });
  const body = (id: string, state: StateId, at: number) => {
    const engine = new BotEngine(100, "idle", bloubShape(id).radii, null);
    engine.setState(state, 0);
    return engine.sample(at).bodyPath;
  };
  for (const id of PICKABLE_BODY_IDS) for (const at of [0.2, 0.8, 1.5, 3, 8]) expect(body(id, bloubState("working"), at), `${id} at ${at}s`).toBe(body(id, "idle", at));
});

test("the same holds for the other motions", () => {
  for (const motion of ["success", "blink", "customize"] satisfies MausMotion[]) expect(motionFor("idle", motion).look).toBe("bot");
  expect(motionFor("idle", "none")).toEqual(motionFor("idle"));
});

// --- the eyes stay inside the body -------------------------------------------------------------
// Measured on the drawn geometry (body outline and each eye as the component paints them), the only
// way to prove what a person sees. Contour helpers follow the upstream skins test.
type Pt = { x: number; y: number };
function bodyContour(d: string): Pt[] {
  const pts: Pt[] = [];
  for (const seg of d.slice(1).split("C")) {
    const n = seg.match(/-?\d+\.?\d*/g)?.map(Number) ?? [];
    if (n.length >= 6) pts.push({ x: n[4]!, y: n[5]! });
    else if (n.length === 2) pts.push({ x: n[0]!, y: n[1]! });
  }
  return pts;
}
function inside(poly: Pt[], x: number, y: number) {
  let on = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) on = !on;
  }
  return on;
}
function eyeContour(eye: RenderedEye, N = 32): Pt[] {
  const g = eye.d.match(/-?\d+\.?\d*/g)!.map(Number);
  const hw = Math.abs(g[0]!), r = Math.abs(g[2]!), straight = Math.abs(g[1]!);
  const [a, b, c, d, e, f] = eye.matrix.match(/-?\d+\.?\d*/g)!.map(Number) as [number, number, number, number, number, number];
  const out: Pt[] = [];
  for (let i = 0; i < N; i++) {
    const u = (i / N) * 4;
    let x: number, y: number;
    if (u < 1) { const t = Math.PI * (u - 0.5); x = Math.cos(t) * r; y = -straight + Math.sin(t) * r; }
    else if (u < 2) { x = hw; y = -straight + (u - 1) * 2 * straight; }
    else if (u < 3) { const t = Math.PI * (u - 2 + 0.5); x = Math.cos(t) * r; y = straight + Math.sin(t) * r; }
    else { x = -hw; y = straight - (u - 3) * 2 * straight; }
    out.push({ x: a * x + c * y + e, y: b * x + d * y + f });
  }
  return out;
}
function worstOverflow(state: StateId, id: string, expression: (typeof EXPRESSIONS)[number] | null) {
  const engine = new BotEngine(100, "idle", bloubShape(id).radii, expression);
  engine.setState(state, 0);
  let worst = 0;
  for (let i = 0; i < 80; i++) {
    const frame = engine.sample(i * 0.05);
    const body = bodyContour(frame.bodyPath);
    for (const eye of frame.eyes) for (const p of eyeContour(eye)) {
      if (inside(body, p.x, p.y)) continue;
      worst = Math.max(worst, Math.min(...body.map((q) => Math.hypot(q.x - p.x, q.y - p.y))));
    }
  }
  return worst;
}

test("while the bot is there, no body the owner can pick cuts its eyes", () => {
  const states = [...new Set([...Object.values(STATE_MOTION), ...Object.values(MOTION_MOTION as Record<string, never>)].filter((m) => m.look === "bot").map((m) => m.engine))] as StateId[];
  const faces = [null, ...EXPRESSIONS];
  const cuts: string[] = [];
  for (const state of states) for (const id of PICKABLE_BODY_IDS) for (const face of faces) {
    const worst = worstOverflow(state, id, face);
    if (worst > 0.05) cuts.push(`${state}/${id}/${face?.id ?? "rest"} ${worst.toFixed(1)}`);
  }
  expect(cuts).toEqual([]);
}, 60_000);
