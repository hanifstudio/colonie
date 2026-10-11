import { describe, expect, it } from "vitest";
import { BotEngine } from "../../third_party/bloub/src/bot/engine";
import { EXPRESSIONS } from "../../third_party/bloub/src/bot/expressions";
import { SHAPE_BY_ID } from "../../third_party/bloub/src/bot/skins";
import { STATES, type StateId } from "../../third_party/bloub/src/bot/states";
import {
  BLOUB_FULL_HALF,
  BLOUB_TIGHT_HALF,
} from "./bloub-gaze";

/** Anchor points of a generated closed path (control points ignored). */
function anchors(d: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const head = /^M(-?[\d.]+) (-?[\d.]+)/.exec(d);
  if (head) out.push([Number(head[1]), Number(head[2])]);
  for (const seg of d.matchAll(/C[-\d. ]+? (-?[\d.]+) (-?[\d.]+)(?=C|Z)/g)) {
    out.push([Number(seg[1]), Number(seg[2])]);
  }
  return out;
}

/** All coordinate pairs of an arc trace ("M x y L x y ..."). */
function tracePoints(d: string): Array<[number, number]> {
  const nums = [...d.matchAll(/-?[\d.]+/g)].map((m) => Number(m[0]));
  const out: Array<[number, number]> = [];
  for (let i = 0; i + 1 < nums.length; i += 2) out.push([nums[i]!, nums[i + 1]!]);
  return out;
}

// States reachable through the app's state mapping in BloubAvatar.
const APP_STATES: StateId[] = [
  "idle", "wink", "burst", "notify", "sleep", "thinking",
  "orbit", "swirl", "comet", "wide", "alert",
];

// Shapes reachable through the app's body mapping in BloubAvatar.
const APP_SHAPES = ["galet", "cercle", "squircle", "capsule", "goutte", "hexagone", "nuage"]
  .map((id) => SHAPE_BY_ID.get(id)?.radii ?? [])
  .filter((radii) => radii.length > 0);

const LOOKS = [
  null,
  { yaw: 40, pitch: 25, mix: 1, spin: 0, wander: 0 },
  { yaw: -40, pitch: -25, mix: 1, spin: 0, wander: 0 },
];

/**
 * Locks the camera contract behind `bloubViewHalf`: arc-free frames (body,
 * face dots, notification badge) must fit the tight window, while visible
 * decor arcs need the full one — and the full one must never clip either.
 * If the upstream engine drifts past these bounds, this fails loudly instead
 * of silently cropping the mascot.
 */
describe("bloub frame fit", () => {
  it("arc-free frames fit the tight camera and decor needs the full one", () => {
    expect(APP_SHAPES.length).toBe(7);
    const states = STATES.filter((s) => APP_STATES.includes(s.id));
    expect(states.length).toBe(APP_STATES.length);
    let restMax = 0;
    let restWorst = "";
    let arcMax = 0;
    const exprs = [null, EXPRESSIONS[0] ?? null, EXPRESSIONS[EXPRESSIONS.length - 1] ?? null];
    for (const state of states) {
      for (const radii of APP_SHAPES) {
        for (const expr of exprs) {
          for (const look of LOOKS) {
            const engine = new BotEngine(100, state.id, radii, expr);
            if (look) engine.setLook(look, 0);
            const steps = Math.max(4, Math.ceil(state.duration / 0.2));
            for (let i = 0; i <= steps; i++) {
              const frame = engine.sample((i / steps) * state.duration);
              let arcsVisible = false;
              for (const arc of frame.arcs) {
                if (arc.opacity <= 0.02) continue;
                arcsVisible = true;
                for (const path of [arc.front, arc.back]) {
                  for (const [x, y] of tracePoints(path)) {
                    arcMax = Math.max(arcMax, Math.abs(x) + arc.width / 2, Math.abs(y) + arc.width / 2);
                  }
                }
              }
              if (arcsVisible) continue;
              let local = 0;
              for (const [x, y] of anchors(frame.bodyPath)) {
                local = Math.max(local, Math.abs(x), Math.abs(y));
              }
              for (const dot of frame.dots) {
                if (dot.d) continue;
                local = Math.max(local, Math.abs(dot.x) + dot.r, Math.abs(dot.y) + dot.r);
              }
              if (frame.notif) {
                local = Math.max(
                  local,
                  Math.abs(frame.notif.x) + frame.notif.r,
                  Math.abs(frame.notif.y) + frame.notif.r,
                );
              }
              if (local > restMax) {
                restMax = local;
                restWorst = `${state.id} look=${look ? `${look.yaw}/${look.pitch}` : "wander"}`;
              }
            }
          }
        }
      }
    }
    expect(
      restMax,
      `arc-free extent ${restMax.toFixed(1)} exceeds tight camera (worst: ${restWorst})`,
    ).toBeLessThanOrEqual(BLOUB_TIGHT_HALF);
    expect(arcMax, "no reachable decor needs the full camera").toBeGreaterThan(BLOUB_TIGHT_HALF);
    expect(arcMax, "decor escapes the full camera").toBeLessThanOrEqual(BLOUB_FULL_HALF);
  }, 120_000);
});
