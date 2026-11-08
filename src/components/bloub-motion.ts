/**
 * What the avatar plays for each thing a bot can be doing. The only place that decides it.
 *
 * Each state is one of two kinds, and the kind is the rule that keeps a bot recognizable:
 *  - "bot":         the bot is still there, so it keeps the body its owner chose (square stays
 *                   square, round stays round) and the face stays on it. Rings may turn around it.
 *  - "transformed": the bot turns into something else for a moment (dots, a "!", a spark), so it
 *                   may lose its body completely.
 *
 * `bloub-motion.test.ts` checks that every "bot" entry really keeps the chosen body with the eyes
 * inside it, and that every "transformed" entry really is an animation of its own. Adding a state
 * to `MausState` fails the build until it is listed here.
 */
import type { StateId } from "../../third_party/bloub/src/bot/states";
import type { MausMotion, MausState } from "@/lib/mascot";

export type BotLook = "bot" | "transformed";
export type Motion = { engine: StateId; look: BotLook };

const bot = (engine: StateId): Motion => ({ engine, look: "bot" });
const transformed = (engine: StateId): Motion => ({ engine, look: "transformed" });

/** What a bot's live state plays. */
export const STATE_MOTION: Record<MausState, Motion> = {
  // at rest
  idle: bot("idle"), listening: bot("idle"), happy: bot("idle"), excited: bot("idle"), proud: bot("idle"),
  curious: bot("idle"), confused: bot("idle"), suspicious: bot("idle"), shy: bot("idle"), bored: bot("idle"),
  sad: bot("idle"), angry: bot("idle"), laughing: bot("idle"), playful: bot("idle"), celebrate: bot("idle"),
  humming: bot("idle"), dictating: bot("idle"), dragging: bot("idle"), bouncing: bot("idle"),
  // surprise
  surprised: bot("wide"), scared: bot("wide"),
  // asking for attention
  notifying: bot("notify"), alerting: bot("notify"),
  // arriving
  spawning: bot("swirl"), waking: bot("swirl"),
  // at work: the bot is there with its rings turning
  working: bot("rings"), writing: bot("rings"), loading: bot("rings"), uploading: bot("rings"),
  progress: bot("rings"), orbit: bot("rings"),
  // turns into three dots
  thinking: transformed("thinking"), searching: transformed("thinking"), radar: transformed("thinking"),
  // turns into a small bouncing ball
  sleeping: transformed("sleep"), drowsy: transformed("sleep"), "powering-down": transformed("sleep"),
  // turns into a comet
  sending: transformed("comet"), receiving: transformed("comet"),
};

/** What a one-shot reaction plays. It wins over the live state while it lasts. */
export const MOTION_MOTION: Partial<Record<MausMotion, Motion>> = {
  failure: transformed("alert"),
  success: bot("wink"),
  blink: bot("wink"),
  customize: bot("wink"),
  celebrate: transformed("burst"),
};

export function motionFor(state: MausState = "idle", motion: MausMotion = "none"): Motion {
  return MOTION_MOTION[motion] ?? STATE_MOTION[state] ?? STATE_MOTION.idle;
}
