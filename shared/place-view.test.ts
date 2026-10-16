import { describe, expect, it } from "vitest";

import en from "../src/locales/en.json";
import {
  PLACE_EN, PLACE_STATES, PLACE_WORDS, placeRowText, placeRowView, placeState, placeView, placeViewOf,
  type PlaceFacts, type PlaceParams, type PlaceSource, type PlaceState,
} from "./place-view.ts";

/** Every param any line or action names, so a state always reads whole. */
const PARAMS: PlaceParams = {
  bot: "Scout", engine: "Claude", model: "Llama", reason: "CUA Driver is not ready.",
  cause: "the Local VM is not ready",
};

const facts = (patch: Partial<PlaceFacts> = {}): PlaceFacts => ({
  place: "vm", server: "mac", bot: "Scout", role: "admin", toolsAllowComputer: true, browserOn: true,
  engine: { name: "Claude", model: "Claude Fable 5", computer: true, browser: true, signedIn: true },
  ...patch,
});

describe("U1: one line and at most one action for every state", () => {
  it("words every state whole, for an Admin and for a User", () => {
    for (const state of PLACE_STATES) {
      for (const role of ["admin", "user"] as const) {
        const view = placeViewOf(state, PARAMS, { role, server: "mac" });
        expect(view.short.trim(), state).not.toBe("");
        expect(view.line.trim(), state).not.toBe("");
        // one message: no second paragraph, no placeholder left unfilled
        expect(view.line, state).not.toMatch(/\n|\{\w+\}/);
        expect(view.short, state).not.toMatch(/\{\w+\}/);
        if (view.action) expect(view.action.label, state).not.toMatch(/^$|\{\w+\}/);
      }
    }
  });

  it("gives a User no action that changes a setting, and says who can", () => {
    for (const state of PLACE_STATES) {
      const admin = placeViewOf(state, PARAMS, { role: "admin", server: "mac" });
      const user = placeViewOf(state, PARAMS, { role: "user", server: "mac" });
      // An action that only opens the panel changes no setting, so a User has it.
      if (!admin.action || admin.action.id === "open-computer-panel") {
        expect(user, state).toEqual(admin);
        continue;
      }
      expect(user.action, state).toBeNull();
      expect(user.line, state).toBe(`${admin.line} Ask an Admin to change it.`);
    }
  });

  it("mirrors en.json exactly, key for key", () => {
    const catalog = en as Record<string, string>;
    for (const [key, value] of Object.entries(PLACE_EN)) expect(catalog[key], key).toBe(value);
    const mirrored = new Set(Object.keys(PLACE_EN));
    const inCatalog = Object.keys(catalog).filter((key) => /^place\.(view|action)\./.test(key) || key === "place.askAdmin" || key === "place.backOnAuto");
    expect(inCatalog.filter((key) => !mirrored.has(key))).toEqual([]);
  });

  it("keeps jargon out of what subscribers read", () => {
    for (const state of PLACE_STATES) {
      const view = placeViewOf(state, PARAMS, { role: "admin", server: "mac" });
      const words = `${view.short} ${view.line} ${view.action?.label ?? ""}`;
      expect(words, state).not.toMatch(/Boat|OMB|Hosted desktop|Cloud box|Works on to Auto|\btools?\b/i);
    }
    for (const [id, sentence] of Object.entries(PLACE_WORDS)) {
      expect(sentence, id).not.toMatch(/Boat|OMB|Hosted desktop|Cloud box|Works on to Auto|\btools?\b/i);
    }
  });
});

describe("placeState", () => {
  it("reads Auto, Off, the browser, this computer and a Local VM", () => {
    expect(placeState(facts({ place: "auto" })).state).toBe("auto");
    expect(placeState(facts({ place: "off" })).state).toBe("off");
    expect(placeState(facts({ place: "browser" })).state).toBe("browser");
    expect(placeState(facts({ place: "browser", browserOn: false })).state).toBe("browser-off");
    expect(placeState(facts({ place: "browser", engine: { name: "X", computer: true, browser: false, signedIn: true } })).state).toBe("browser-cannot");
    expect(placeState(facts({ place: "local", local: { ready: false, reason: "Not yet." } }))).toEqual({
      state: "local-unavailable", params: { bot: "Scout", reason: "Not yet." },
    });
    expect(placeState(facts({ place: "vm", engine: { name: "X", computer: false, browser: true, signedIn: true } })).state).toBe("vm-cannot");
    expect(placeState(facts({ place: "vm" })).state).toBe("vm");
  });

  it("still words a stored cloud computer's place as this computer's screen", () => {
    // ponytail guard: data written before the cloud place was removed.
    expect(placeState(facts({ place: "cloud" as unknown as PlaceFacts["place"] })).state).toBe("local");
    expect(placeRowView({ state: "cc-on" as PlaceState, params: { bot: "Scout" }, source: "works-on" }, { role: "admin" }).state).toBe("local");
  });

  it("words the Auto line for where this server runs", () => {
    expect(placeView(facts({ place: "auto" })).line).toMatch(/this computer's screen/);
    expect(placeView(facts({ place: "auto", server: "linux" })).line).toMatch(/Local VM/);
  });
});

describe("a failed place, by where it came from", () => {
  const row = (source: PlaceSource) => ({ state: "place-failed" as PlaceState, params: { bot: "Scout", cause: "the Local VM is not ready" }, source });

  const view = (source: PlaceSource, mode?: "simple" | "advanced") =>
    placeRowView(row(source), { role: "admin", mode, worksOnLabel: "Auto" });

  it("has its own way on per source", () => {
    expect(view("works-on").action).toEqual({ id: "open-computer-panel", label: "Open Computer panel" });
    expect(view("auto-pin").action).toEqual({ id: "try-again", label: "Try again" });
    expect(view("pin", "advanced").action).toEqual({ id: "clear-pin", label: "Clear this conversation's place" });
    expect(view("pin", "simple").action).toEqual({ id: "clear-pin", label: "Use Auto" });
    expect(view("routine").action).toEqual({ id: "change-routine", label: "Change where it runs" });
    expect(view("room").action).toBeNull();
  });

  it("keeps a state's own fix whatever the source", () => {
    for (const source of ["works-on", "pin", "auto-pin", "routine", "room"] as const) {
      expect(placeRowView({ state: "vm-cannot", params: { bot: "Scout", model: "Llama" }, source }, { role: "admin" }).action?.id, source).toBe("choose-model");
    }
  });

  it("stores the line and its action as words a phone can read", () => {
    expect(placeRowText(row("works-on"))).toBe("the Local VM is not ready Check it in the Computer panel.");
    expect(placeRowText(row("auto-pin"))).toBe("the Local VM is not ready This conversation is back on Auto. Send your message again.");
    expect(placeRowText(row("routine"))).toBe("the Local VM is not ready Change where this routine runs.");
    expect(placeRowText(row("room"))).toBe("the Local VM is not ready");
    expect(placeRowText({ state: "vm-cannot", params: { bot: "Scout", model: "Llama" }, source: "works-on" }))
      .toBe("Llama can't use a Local VM. Choose a model that can, such as Claude or ChatGPT. Choose another model in Scout's settings.");
  });
});