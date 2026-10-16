// Where a bot works, said once: one plain line and at most one next action for
// every state a place can be in, from facts the server and the app already
// hold. The server words a failed turn's row from it (English, so a language
// phone can read it), and every control that shows or picks a place
// (the Computer panel's cards and Simple grid, the composer chip, the failed
// turn row, the bot's Access settings) renders the same state from it in the
// person's language. Nothing else decides what a place is called or what to do
// when it can't be used.
//
// The English below mirrors src/locales/en.json `place.view.*`,
// `place.action.*` and `place.askAdmin`/`place.backOnAuto` exactly (a test
// holds them together), the way shared/live-approval.ts mirrors its keys:
// the server has no i18n.

export type Place = "vm" | "local" | "browser";

/** Every state a place can be in. */
export const PLACE_STATES = [
  "auto",
  "browser", "browser-off", "browser-cannot",
  "local", "local-unavailable", "vm", "vm-cannot", "place-failed",
  "off",
] as const;
export type PlaceState = (typeof PLACE_STATES)[number];

/** Where a failed place came from: the one control a person changes when it
 * can't be used. A routine and a room member are their own sources; Auto and
 * a team's shared computer name no place, so they never fail as one. */
export type PlaceSource = "works-on" | "pin" | "auto-pin" | "routine" | "room";

/** The next actions a place offers. Each is one button in the app and, on a
 * stored row, one sentence a phone can read. */
export const PLACE_ACTIONS = [
  "choose-model", "open-tools", "sign-in", "start", "wake", "watch",
  "try-again", "turn-on-browser", "open-vm-settings",
  "clear-pin", "change-routine", "open-computer-panel",
] as const;
export type PlaceActionId = (typeof PLACE_ACTIONS)[number];

/** What a failed-turn row stores about its place, beside its English words,
 * so the app can word it again in the reader's language. */
export interface PlaceRow {
  state: PlaceState;
  params: PlaceParams;
  source: PlaceSource;
}

export interface PlaceParams {
  bot?: string;
  engine?: string;
  model?: string;
  reason?: string;
  cause?: string;
}

export interface PlaceAction {
  id: PlaceActionId;
  label: string;
}

export interface PlaceView {
  state: PlaceState;
  params: PlaceParams;
  /** A few words for a card, a grid tile or a chip row. */
  short: string;
  /** The one plain message. */
  line: string;
  action: PlaceAction | null;
}

/** Where this server runs, as the Auto line describes it. */
export type ServerKind = "mac" | "pc" | "linux";

/** The facts a place's state is read from. */
export interface PlaceFacts {
  /** The place to describe: Auto, Off, or one of the three places. */
  place: Place | "auto" | "off";
  server: ServerKind;
  bot: string;
  engine: {
    name: string;
    model?: string;
    /** It can use computer tools (capabilities.computerMcp). */
    computer: boolean;
    /** It can use the built-in browser (capabilities.browserMcp). */
    browser: boolean;
    /** Not waiting on a sign-in (src/lib/failed-turn.ts engineSignedOut). */
    signedIn: boolean;
  };
  /** The bot's tool selection includes the computer. */
  toolsAllowComputer: boolean;
  /** The built-in browser is switched on for this installation and bot. */
  browserOn: boolean;
  role: "admin" | "user";
  mode?: "simple" | "advanced";
  /** This computer can be picked; `reason` says why not. */
  local?: { ready: boolean; reason?: string };
}

/** The English catalog, mirrored by en.json. */
export const PLACE_EN = {
  "place.view.auto.short": "Chooses for you",
  "place.view.auto.lineDesktop": "Uses the built-in browser, a private desktop on this computer, or this computer's screen, whichever the task needs.",
  "place.view.auto.lineLinux": "Uses the built-in browser, or a running Local VM when a task needs a desktop.",
  "place.view.browser.short": "Web pages only",
  "place.view.browser.line": "Works in the built-in browser only: web pages, no desktop apps.",
  "place.view.browserOff.short": "Browser is off",
  "place.view.browserOff.line": "The built-in browser is switched off.",
  "place.view.browserCannot.short": "Not with this model",
  "place.view.browserCannot.line": "{model} can't use the built-in browser.",
  "place.view.local.short": "Your screen",
  "place.view.local.line": "Uses your screen, mouse, and keyboard.",
  "place.view.localUnavailable.short": "Not ready",
  "place.view.localUnavailable.line": "{reason}",
  "place.view.vm.short": "Private desktop",
  "place.view.vm.line": "A private Linux desktop on this device, separate from your own screen.",
  "place.view.vmCannot.short": "Not with this model",
  "place.view.vmCannot.line": "{model} can't use a Local VM. Choose a model that can, such as Claude or ChatGPT.",
  "place.view.placeFailed.short": "Didn't start",
  "place.view.placeFailed.line": "{cause}",
  "place.view.off.short": "No screen",
  "place.view.off.line": "{bot} has no screen. It can still chat and do anything that doesn't need one.",
  "place.action.chooseModel": "Choose a model",
  "place.action.openTools": "Change what {bot} can use",
  "place.action.signIn": "Sign in",
  "place.action.start": "Start it now",
  "place.action.wake": "Wake it now",
  "place.action.watch": "Watch",
  "place.action.tryAgain": "Try again",
  "place.action.turnOnBrowser": "Turn on the browser",
  "place.action.openVmSettings": "Local VM settings",
  "place.action.clearPin": "Clear this conversation's place",
  "place.action.usePlace": "Use {place}",
  "place.action.changeRoutine": "Change where it runs",
  "place.action.openComputerPanel": "Open Computer panel",
  "place.askAdmin": "Ask an Admin to change it.",
  "place.backOnAuto": "This conversation is back on Auto.",
} as const;
export type PlaceKey = keyof typeof PLACE_EN;

/** A stored row's next action as one English sentence: what a phone, which
 * shows only the row's words, reads instead of a button. English only, like
 * the row it ends. */
export const PLACE_WORDS: Record<PlaceActionId, string> = {
  "choose-model": "Choose another model in {bot}'s settings.",
  "open-tools": "Change what {bot} can use in its settings.",
  "sign-in": "Sign in to {engine} in Settings.",
  start: "Start it from the Computer panel.",
  wake: "Wake it from the Computer panel.",
  watch: "Watch it from the Computer panel.",
  "try-again": "Try again.",
  "turn-on-browser": "Turn on the built-in browser in the Computer panel.",
  "open-vm-settings": "Check it in Settings → Local VM.",
  "clear-pin": "Clear this conversation's place in the composer to continue.",
  "change-routine": "Change where this routine runs.",
  "open-computer-panel": "Check it in the Computer panel.",
};

/** The words a person reads, in some language: the app passes its t(), the
 * server the English mirror. */
export type PlaceTranslate = (key: PlaceKey, params?: Record<string, string | number>) => string;

function fill(template: string, params: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (Object.hasOwn(params, name) ? String(params[name]) : whole));
}

export const english: PlaceTranslate = (key, params) => fill(PLACE_EN[key], params);

/** Each state's key segment, short and line keys, and own action. */
const STATE: Record<PlaceState, { key: string; action: PlaceActionId | null }> = {
  auto: { key: "auto", action: null },
  browser: { key: "browser", action: null },
  "browser-off": { key: "browserOff", action: "turn-on-browser" },
  "browser-cannot": { key: "browserCannot", action: "choose-model" },
  local: { key: "local", action: null },
  "local-unavailable": { key: "localUnavailable", action: null },
  vm: { key: "vm", action: "open-vm-settings" },
  "vm-cannot": { key: "vmCannot", action: "choose-model" },
  "place-failed": { key: "placeFailed", action: "open-computer-panel" },
  off: { key: "off", action: null },
};

/** A passing cause: nothing to fix, so where the place came from decides the
 * way on (sourceAction). Every other state's action removes its cause. */
const PASSING: ReadonlySet<PlaceState> = new Set(["place-failed"]);

/** Actions that change a setting or a sign-in: a User can't take them, so the
 * line ends "Ask an Admin to change it." instead. */
const ADMIN_ONLY: ReadonlySet<PlaceActionId> = new Set([
  "choose-model", "open-tools", "sign-in", "turn-on-browser", "open-vm-settings", "change-routine",
]);
/** Starting or waking a computer early: a User's own message does it, so
 * there is nothing to ask anyone for. */
const ADMIN_SHORTCUT: ReadonlySet<PlaceActionId> = new Set(["start", "wake"]);

const ACTION_KEY: Record<PlaceActionId, PlaceKey> = {
  "choose-model": "place.action.chooseModel",
  "open-tools": "place.action.openTools",
  "sign-in": "place.action.signIn",
  start: "place.action.start",
  wake: "place.action.wake",
  watch: "place.action.watch",
  "try-again": "place.action.tryAgain",
  "turn-on-browser": "place.action.turnOnBrowser",
  "open-vm-settings": "place.action.openVmSettings",
  "clear-pin": "place.action.clearPin",
  "change-routine": "place.action.changeRoutine",
  "open-computer-panel": "place.action.openComputerPanel",
};

/** The state and its params, from the facts. Pure: the panel, the chip, the
 * Access line and the server all ask this. */
export function placeState(facts: PlaceFacts): { state: PlaceState; params: PlaceParams } {
  const bot = facts.bot;
  const model = facts.engine.model || facts.engine.name;
  // ponytail: stored bots from before the cloud computer place was removed can
  // still carry `computer: "cloud"`; word it as this computer's screen. Drop
  // once no such data exists.
  const place = (facts.place as string) === "cloud" ? "local" : facts.place;
  if (place === "off") return { state: "off", params: { bot } };
  if (place === "auto") return { state: "auto", params: { bot } };
  if (place === "browser") {
    if (!facts.engine.browser) return { state: "browser-cannot", params: { bot, model } };
    return facts.browserOn ? { state: "browser", params: { bot } } : { state: "browser-off", params: { bot } };
  }
  if (place === "local") {
    return facts.local?.ready === false
      ? { state: "local-unavailable", params: { bot, reason: facts.local.reason ?? "" } }
      : { state: "local", params: { bot } };
  }
  return facts.engine.computer ? { state: "vm", params: { bot } } : { state: "vm-cannot", params: { bot, model } };
}

/** Where the person goes when a passing cause stops a place: try again in
 * place, clear the pin that holds this conversation, change where the
 * routine runs. A room member's turn has no retry of its own. */
function sourceAction(source: PlaceSource, state: PlaceState): PlaceActionId | null {
  switch (source) {
    case "works-on": return state === "place-failed" ? "open-computer-panel" : "try-again";
    case "auto-pin": return "try-again";
    case "pin": return "clear-pin";
    case "routine": return "change-routine";
    case "room": return null;
  }
}

function lineKey(state: PlaceState, server?: ServerKind): PlaceKey {
  const segment = STATE[state].key;
  if (state === "auto") return server === "linux" ? "place.view.auto.lineLinux" : "place.view.auto.lineDesktop";
  return `place.view.${segment}.line` as PlaceKey;
}

/** Join names the way a sentence lists them, in the reader's language. */
export function listNames(names: readonly string[], locale = "en"): string {
  try {
    return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(names);
  } catch {
    return names.join(", ");
  }
}

function templateParams(params: PlaceParams, locale: string): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined) continue;
    out[name] = Array.isArray(value) ? listNames(value, locale) : value;
  }
  return out;
}

export interface PlaceContext {
  server?: ServerKind;
  role: "admin" | "user";
  mode?: "simple" | "advanced";
  source?: PlaceSource;
  /** Simple mode words a pin's way back as "Use {place}", the grid's own label. */
  worksOnLabel?: string;
  translate?: PlaceTranslate;
  locale?: string;
}

/** One state, worded: its short label, its one line and its one action. */
export function placeViewOf(state: PlaceState, params: PlaceParams, context: PlaceContext): PlaceView {
  const translate = context.translate ?? english;
  const values = templateParams(params, context.locale ?? "en");
  const segment = STATE[state].key;
  let line = translate(lineKey(state, context.server), values);
  let action: PlaceActionId | null = context.source && PASSING.has(state) ? sourceAction(context.source, state) : STATE[state].action;
  // A failed row never offers what only the panel can do on the spot.
  if (context.source && (action === "start" || action === "wake" || action === "watch")) action = null;
  if (context.source === "auto-pin") line = `${line} ${translate("place.backOnAuto")}`;
  // Simple mode leaves Local VM setup to Advanced.
  if (action === "open-vm-settings" && context.mode === "simple") action = null;
  if (action && context.role === "user" && ADMIN_SHORTCUT.has(action)) action = null;
  if (action && context.role === "user" && ADMIN_ONLY.has(action)) {
    action = null;
    line = `${line} ${translate("place.askAdmin")}`;
  }
  // Simple mode has no composer chip, so a pin's way back is the grid's
  // choice, by the grid's own name for it.
  const label = !action ? null
    : action === "clear-pin" && context.mode === "simple" && context.worksOnLabel
      ? translate("place.action.usePlace", { place: context.worksOnLabel })
      : translate(ACTION_KEY[action], values);
  return {
    state,
    params,
    short: translate(`place.view.${segment}.short` as PlaceKey, values),
    line,
    action: action && label ? { id: action, label } : null,
  };
}

/** A stored place state from data written before the cloud computer place was
 * removed (cc-* states) reads as this computer's screen. ponytail: drop once
 * no such rows exist. */
function storedState(state: PlaceState): PlaceState {
  return state in STATE ? state : "local";
}

/** The view of a place from its facts. */
export function placeView(facts: PlaceFacts, options: { translate?: PlaceTranslate; locale?: string } = {}): PlaceView {
  const { state, params } = placeState(facts);
  return placeViewOf(state, params, { server: facts.server, role: facts.role, mode: facts.mode, ...options });
}

/** A stored failed-turn row, worded for this reader. */
export function placeRowView(row: PlaceRow, context: Omit<PlaceContext, "source">): PlaceView {
  return placeViewOf(storedState(row.state), row.params, { ...context, source: row.source });
}

/** What the server stores as the row's words: the line and its action as a
 * sentence, in English, so a phone that reads only the words knows both. */
export function placeRowText(row: PlaceRow, server?: ServerKind): string {
  const view = placeViewOf(storedState(row.state), row.params, { server, role: "admin", source: row.source });
  if (!view.action) return view.line;
  const words = row.source === "auto-pin" && view.action.id === "try-again"
    ? "Send your message again."
    : fill(PLACE_WORDS[view.action.id], templateParams(row.params, "en"));
  return `${view.line} ${words}`;
}