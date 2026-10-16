// First-run state and the welcome flow's beat machine, kept pure so the
// decisions (show the tour? which beat is next? what to persist?) are unit
// tested without React. The record itself lives in the workspace config on
// the server, never in browser storage: clearing site data or opening a
// second profile must not replay the tour, and a phone paired later should
// see the same hints as already dismissed.

export interface OnboardingStatus {
  /** ISO timestamp; "" until the welcome flow has been finished or skipped. */
  completedAt: string;
  /** Which welcome flow was completed; a newer flow may re-show itself. */
  version: number;
  reelSeen: boolean;
  hintsSeen: string[];
  /** OMB Cloud home only: when a bot's turn first finished there. The
   * server writes it (server/cloud-home.ts firstCloudTurnPatch). */
  firstTurnAt?: string;
}

/** Bump when the welcome flow changes enough that existing users should see
 * it again. Completions at an older version count as not done. */
export const WELCOME_VERSION = 1;

export const EMPTY_ONBOARDING: OnboardingStatus = {
  completedAt: "",
  version: 0,
  reelSeen: false,
  hintsSeen: [],
};

/** Who is opening the app, as far as first run cares. */
export interface WelcomeViewer {
  /** A hosted team workspace: its organisation's Admin assigns the models. */
  hosted: boolean;
  /** This session may write the workspace config. Finishing the welcome
   * flow is such a write, and `PUT /api/config` is admin-only. */
  canSave: boolean;
  /** An OMB Cloud home (docs/cloud-pro.md): its first run is the engine
   * sign-in, not the welcome flow, which describes the person's computer. */
  cloudHome?: boolean;
}

/** The desktop app's own window talking to its own server: never hosted,
 * always the owner. Known without asking, so its first run never waits. */
export const LOCAL_VIEWER: WelcomeViewer = { hosted: false, canSave: true };

/** A hosted workspace's member. The workspace config is its admins', so no
 * first-run surface that writes it (the flow, the spotlights) is offered;
 * the member gets a note instead. Anywhere else a session without admin
 * scope is often the owner's own paired browser, and nothing is added. */
export function hostedMember(viewer: WelcomeViewer | null): boolean {
  return Boolean(viewer?.hosted && !viewer.canSave);
}

/** First-conversation spotlights wait for the viewer to be known, and never
 * show to a hosted member, who could not dismiss them for good. */
export function spotlightsQuiet(viewer: WelcomeViewer | null): boolean {
  return viewer === null || hostedMember(viewer);
}

/** Read `GET /api/auth/session` defensively. A server that sends no scopes
 * reads as today (the owner); one that predates `hosted` reads as not
 * hosted, which is also what it always was to the welcome flow. */
export function welcomeViewer(session: unknown): WelcomeViewer {
  const record = session && typeof session === "object" ? (session as { hosted?: unknown; scopes?: unknown; cloudHome?: unknown }) : {};
  return {
    hosted: record.hosted === true,
    canSave: Array.isArray(record.scopes) ? record.scopes.includes("admin") : true,
    ...(record.cloudHome === true ? { cloudHome: true } : {}),
  };
}

/** Whether the welcome flow should open on launch. Null config means the
 * server has not answered yet; showing the tour on a guess would flash it at
 * every returning user, so the answer is no until the record arrives.
 *
 * A session that cannot save the workspace config never gets it: it would
 * fail to save and come back on every visit. On a hosted workspace the tour
 * waits until the session is known to be an admin's. A Cloud home opens on
 * its engine sign-in instead; the flow can still be replayed
 * from Settings. Callers that pass none of these fields keep the old answer. */
export function welcomeDue(
  config: { onboarding?: OnboardingStatus } | null | undefined,
  options: { remoteClient: boolean; legacyDone: boolean; hosted?: boolean; canSave?: boolean; cloudHome?: boolean },
): boolean {
  if (options.remoteClient || options.cloudHome) return false;
  if (options.canSave === false) return false;
  if (options.hosted && options.canSave !== true) return false;
  if (!config) return false;
  const record = config.onboarding ?? EMPTY_ONBOARDING;
  if (record.completedAt && record.version >= WELCOME_VERSION) return false;
  // One release of grace for installs that finished the old localStorage
  // gate: they are not new, so they are not shown the new flow either.
  if (!record.completedAt && options.legacyDone) return false;
  return true;
}

/** The config patch that marks the welcome flow done. Sent through the same
 * `PUT /api/config` path as the profile; sections merge server-side, so
 * hints already seen survive a replay. */
export function completionPatch(now: Date = new Date()): { onboarding: { completedAt: string; version: number } } {
  return { onboarding: { completedAt: now.toISOString(), version: WELCOME_VERSION } };
}

export function hintSeen(record: OnboardingStatus | undefined, id: string): boolean {
  return (record?.hintsSeen ?? []).includes(id);
}

/** Null when nothing needs saving, so callers never issue a no-op write. */
export function hintSeenPatch(
  record: OnboardingStatus | undefined,
  id: string,
): { onboarding: { hintsSeen: string[] } } | null {
  if (hintSeen(record, id)) return null;
  return { onboarding: { hintsSeen: [...(record?.hintsSeen ?? []), id] } };
}

// ── beats ──────────────────────────────────────────────────────────────

export type BeatId = "hello" | "reel" | "engines" | "permissions" | "bot";

export interface BeatOptions {
  /** The desktop app can ask for the microphone; a browser cannot. */
  dictation: boolean;
  /** The feature reel ships in a later phase; it is a beat the machine
   * already knows so that turning it on is one flag. */
  reel: boolean;
  /** A hosted team workspace: nothing is installed or granted on this
   * computer, and there is no phone to pair to it. */
  hosted?: boolean;
}

/** Beats in order for this session. The exit beat is always last so the
 * seeded bot is named even when everything else was skipped. A hosted
 * workspace gets a greeting and the bot: its organisation assigns the models,
 * and the reel, engines and microphone beats all describe this
 * computer, which a hosted workspace is not. */
export function beatsFor(options: BeatOptions): BeatId[] {
  if (options.hosted) return ["hello", "bot"];
  const beats: BeatId[] = ["hello"];
  if (options.reel) beats.push("reel");
  beats.push("engines");
  if (options.dictation) beats.push("permissions");
  beats.push("bot");
  return beats;
}

export function nextBeat(beats: readonly BeatId[], current: BeatId): BeatId | null {
  const index = beats.indexOf(current);
  if (index < 0 || index + 1 >= beats.length) return null;
  return beats[index + 1]!;
}

export function previousBeat(beats: readonly BeatId[], current: BeatId): BeatId | null {
  const index = beats.indexOf(current);
  if (index <= 0) return null;
  return beats[index - 1]!;
}

/** The card is one element for the whole flow; its width is the one thing
 * that morphs between beats. Engines lays tiles out two across and needs
 * the room; the rest read best narrow. */
export function beatWidth(beat: BeatId): number {
  switch (beat) {
    case "engines":
      return 680;
    case "reel":
      return 720;
    case "bot":
      return 520;
    default:
      return 460;
  }
}

/** The footer's step dots. The reel beat draws its own scene dots (six,
 * clickable) just above the footer, and two rows of dots with different
 * counts read as one broken progress bar, so the reel keeps only its own;
 * the footer still says "Step 2 of 5". */
export function flowDotsShown(beat: BeatId): boolean {
  return beat !== "reel";
}

// ── engines ────────────────────────────────────────────────────────────

interface SummaryInstance {
  install?: unknown;
}

/** What the engines beat counts: the engines that can run, and the ones still
 * needing setup. */
export function engineSummary<Instance extends SummaryInstance>(
  instances: readonly Instance[],
  ready: (instance: Instance) => boolean,
): { ready: Instance[]; setup: Instance[]; allReady: boolean } {
  const engines = instances.filter((instance) => instance.install);
  const personal = engines.filter(ready);
  const setup = engines.filter((instance) => !ready(instance));
  return { ready: personal, setup, allReady: personal.length > 0 && setup.length === 0 };
}

// ── motion ─────────────────────────────────────────────────────────────

/** The OS preference, plus a dev hook the preview page uses to show the
 * reduced variant without changing system settings. */
export function reducedMotion(): boolean {
  if (typeof document !== "undefined" && document.documentElement.dataset.reducedMotion === "true") return true;
  return globalThis.window?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}
