// The app's reading of shared/place-view.ts: the facts for a bot's place
// from what the app already holds, its words in the person's language, and
// what each next action does. The Computer panel's cards and Simple grid, the
// composer chip, a failed turn's row and the bot's Access line all render
// through here, so for the same facts they say the same thing.
import { activeLocale, t } from "@/lib/i18n";
import { engineSignedOut } from "@/lib/failed-turn";
import { browserAvailable, builtInBrowserEnabled, type FeatureFlagConfig } from "@/lib/feature-flags";
import { writeComputerPanelView } from "@/lib/computer-panel-view";
import { useAdvancedMode } from "@/lib/interface-mode";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import type { Action, Bot, InstanceInfo } from "@/state/store";
import type { LocaleKey } from "@/locales";
import {
  placeRowView, placeView, type PlaceActionId, type PlaceFacts, type PlaceRow, type PlaceTranslate, type PlaceView, type ServerKind,
} from "../../shared/place-view";
import { canUseMcpServer } from "../../shared/tool-scope";

/** The catalog's words for a place key (src/locales/en.json mirrors it). */
export const placeTranslate: PlaceTranslate = (key, params) => t(key as LocaleKey, params);

/** What the app knows about where it runs and who is looking. */
export interface PlaceSeat {
  server: ServerKind;
  role: "admin" | "user";
  mode: "simple" | "advanced";
}

export function serverKind(platform: DesktopCapabilities["host"]["platform"]): ServerKind {
  return platform === "darwin" ? "mac" : platform === "win32" ? "pc" : "linux";
}

/** The engine facts a place reads, from the bot's engine. */
function engineFacts(instance: InstanceInfo | undefined, model: string | undefined): PlaceFacts["engine"] {
  const label = instance?.models?.options?.find((option) => option.id === model)?.label;
  return {
    name: instance?.displayName || instance?.driverKind || model || "",
    model: label || model || instance?.displayName || "",
    computer: instance?.capabilities?.computerMcp === true,
    browser: instance?.capabilities?.browserMcp === true,
    signedIn: !engineSignedOut(instance),
  };
}

/** Every fact of a bot's place but the place itself and its live state. */
export function placeFacts(input: {
  bot: Pick<Bot, "name" | "modelSelection" | "toolScope">;
  place: PlaceFacts["place"];
  seat: PlaceSeat;
  config: FeatureFlagConfig | null | undefined;
  instances: InstanceInfo[];
  local?: PlaceFacts["local"];
}): PlaceFacts {
  const { bot, config, seat } = input;
  const instance = input.instances.find((candidate) => candidate.instanceId === bot.modelSelection.instanceId);
  return {
    place: input.place,
    server: seat.server,
    bot: bot.name,
    engine: engineFacts(instance, bot.modelSelection.model),
    toolsAllowComputer: canUseMcpServer(bot.toolScope, "computer"),
    browserOn: builtInBrowserEnabled(config) && browserAvailable(config),
    role: seat.role,
    mode: seat.mode,
    ...(input.local ? { local: input.local } : {}),
  };
}

/** One place's view, in the person's language. */
export function placeViewFor(facts: PlaceFacts): PlaceView {
  return placeView(facts, { translate: placeTranslate, locale: activeLocale() });
}

/** A stored failed-turn row's place, worded for this reader. */
export function placeRowViewFor(row: PlaceRow, seat: PlaceSeat, worksOnLabel?: string): PlaceView {
  return placeRowView(row, { server: seat.server, role: seat.role, mode: seat.mode, worksOnLabel, translate: placeTranslate, locale: activeLocale() });
}

/** Whether a place can't be picked at all: no setting here makes it work. */
export function placeBlocked(view: PlaceView): boolean {
  return view.state === "browser-off" || view.state === "browser-cannot"
    || view.state === "vm-cannot" || view.state === "local-unavailable";
}

/** Where this app runs and who is looking: one hook for every place control. */
export function usePlaceSeat(platform: DesktopCapabilities["host"]["platform"]): PlaceSeat {
  const ownerOrAdmin = useOwnerOrAdmin();
  const advanced = useAdvancedMode();
  return { server: serverKind(platform), role: ownerOrAdmin === false ? "user" : "admin", mode: advanced ? "advanced" : "simple" };
}

/** What a place's next action does, for actions that open somewhere: the
 * same destination from the panel, the chip, a failed row or the Access
 * line. Actions that need the caller's own state (try again, start, wake,
 * turn on the browser) are the caller's. */
export function openPlaceAction(
  id: PlaceActionId,
  target: { botId: string; threadId?: string },
  dispatch: (action: Action) => void,
): boolean {
  const appSettings = (section: "engines" | "computer" | "connections") =>
    dispatch({ type: "toggleAppSettings", open: true, section });
  switch (id) {
    case "choose-model": dispatch({ type: "toggleSettings", open: true, section: "model", botId: target.botId }); return true;
    case "open-tools": dispatch({ type: "toggleSettings", open: true, section: "access", botId: target.botId }); return true;
    case "change-routine": dispatch({ type: "toggleSettings", open: true, section: "routines", botId: target.botId }); return true;
    case "sign-in": appSettings("engines"); return true;
    case "open-vm-settings":
      window.sessionStorage?.setItem("openmausbot.settings.section", "computer");
      appSettings("computer");
      return true;
    case "clear-pin":
      if (!target.threadId) return false;
      dispatch({ type: "updateTask", botId: target.botId, threadId: target.threadId, patch: { surface: null } });
      return true;
    case "watch":
    case "open-computer-panel":
    case "turn-on-browser":
      writeComputerPanelView(target.botId, id === "turn-on-browser" ? "browser" : "computer");
      dispatch({ type: "toggleComputer", open: true });
      return true;
    default:
      return false;
  }
}

/** The Simple grid's own name for a Works on choice: the words "Use {place}"
 * names a pin's way back with, so it matches the tile the person sees. */
export const SIMPLE_PLACE_LABEL = {
  auto: "vm.dest.auto",
  vm: "vm.dest.vm",
  browser: "vm.dest.browser",
  off: "vm.dest.off",
} as const satisfies Record<"auto" | "vm" | "browser" | "off", LocaleKey>;

export function worksOnSimpleLabel(computer: Bot["computer"], platform: DesktopCapabilities["host"]["platform"]): string {
  if (computer === "local") return t(platform === "darwin" ? "computer.simple.dest.thisMac" : "computer.simple.dest.thisPc");
  return t(SIMPLE_PLACE_LABEL[computer ?? "auto"]);
}
