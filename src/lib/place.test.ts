import { describe, expect, it } from "vitest";
import { effectivePlace, isComputerPlace, PLACES, placeLabelKey, placeOffered, toolPlace } from "./place";
import { toolSurfaceKind } from "../../shared/tool-surface";

describe("where a conversation works", () => {
  it("lets the conversation's pin win over the bot's Works on, except Off", () => {
    expect(effectivePlace({ computer: "vm" }, { surface: "browser" })).toBe("browser");
    expect(effectivePlace({ computer: undefined }, { surface: "vm" })).toBe("vm");
    expect(effectivePlace({ computer: "browser" }, { surface: "local" })).toBe("local");
    expect(effectivePlace({ computer: "off" }, { surface: "browser" })).toBe("off");
    expect(effectivePlace({ computer: "vm" }, null)).toBe("vm");
    expect(effectivePlace({ computer: undefined }, undefined)).toBe("auto");
  });

  it("still words a stored cloud computer's pin as this computer's screen", () => {
    // ponytail guard: a conversation stored before the cloud place was removed.
    const bot = { computer: "cloud" } as unknown as { computer: "vm" | "local" | "browser" | "off" };
    const task = { surface: "cloud" } as unknown as { surface: "vm" | "local" | "browser" | undefined };
    expect(effectivePlace(bot, null)).toBe("local");
    expect(effectivePlace({ computer: undefined }, task)).toBe("local");
  });

  it("offers every place on a desktop or self-hosted server, and only the browser on an COLONIE Cloud home", () => {
    for (const config of [null, undefined, {}, { cloudHome: false }]) {
      expect(PLACES.filter((place) => placeOffered(place, config))).toEqual(["vm", "local", "browser"]);
    }
    expect(PLACES.filter((place) => placeOffered(place, { cloudHome: true }))).toEqual(["browser"]);
  });

  it("names places with one label key each", () => {
    expect(placeLabelKey("vm")).toBe("place.vm");
    expect(placeLabelKey("auto")).toBe("place.auto");
    expect(isComputerPlace("vm")).toBe(true);
    expect(isComputerPlace("browser")).toBe(false);
    expect(isComputerPlace("auto")).toBe(false);
  });

  it("gives browser tools the browser, computer tools the conversation's computer, and other tools nothing", () => {
    expect(toolPlace("agent_browser_snapshot", "vm")).toBe("browser");
    expect(toolPlace("mcp__browser__browser_click", "vm")).toBe("browser");
    expect(toolPlace("mcp__computer__screenshot", "vm")).toBe("vm");
    expect(toolPlace("click", "local")).toBe("local");
    expect(toolPlace("computer_exec", "vm")).toBe("vm");
    // the computer server's browser_click acts inside the desktop
    expect(toolPlace("browser_click", "vm")).toBe("vm");
    // an unpinned Auto conversation has no known computer yet
    expect(toolPlace("screenshot", "auto")).toBeNull();
    expect(toolPlace("screenshot", "browser")).toBeNull();
    for (const name of ["Bash", "Read", "list_bots", "recall", "propose_routine", "mcp__agents__ask_bot"]) {
      expect(toolPlace(name, "vm"), name).toBeNull();
    }
  });

  it("classifies tool names without guessing computer for unrelated tools", () => {
    expect(toolSurfaceKind("agent_browser_open")).toBe("browser");
    expect(toolSurfaceKind("browser__snapshot")).toBe("browser");
    expect(toolSurfaceKind("computer__click")).toBe("computer");
    expect(toolSurfaceKind("hotkey")).toBe("computer");
    expect(toolSurfaceKind("Bash")).toBeNull();
    expect(toolSurfaceKind("mcp__agents__list_bots")).toBeNull();
  });
});