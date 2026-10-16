// Where a turn's hands land. The policy is small but every branch was a
// real confusion: a browser-only bot that still got a computer, an Auto
// task that hopped surfaces between turns, a plea that named no place.
import { describe, expect, it } from "vitest";

import {
  computerToolsReason,
  parseSurface,
  placeUnavailable,
  resolveSurface,
  surfaceOfComputerKind,
  surfacePrompt,
} from "./surface.ts";

describe("resolveSurface", () => {
  it("browser destination mounts only the built-in browser", () => {
    expect(resolveSurface({ destination: "browser", browserOn: true })).toEqual({
      computer: "off",
      browser: true,
      pinned: null,
      note: "",
    });
  });

  it("browser destination with the browser switched off mounts nothing and says so", () => {
    const plan = resolveSurface({ destination: "browser", browserOn: false });
    expect(plan.computer).toBe("off");
    expect(plan.browser).toBe(false);
    expect(plan.note).toMatch(/switched off in App Settings/);
    expect(plan.note).toMatch(/no browser and no computer/);
  });

  it("a computer destination mounts only that computer: one place per turn", () => {
    for (const destination of ["vm", "local"] as const) {
      // the bot's browser switch no longer adds a second place next to a computer
      expect(resolveSurface({ destination, browserOn: true })).toEqual({ computer: destination, browser: false, pinned: null, note: "" });
      expect(resolveSurface({ destination, browserOn: false })).toMatchObject({ computer: destination, browser: false });
    }
  });

  it("Off mounts no computer and no browser, and says which setting did it", () => {
    const plan = resolveSurface({ destination: "off", browserOn: true });
    expect(plan).toMatchObject({ computer: "off", browser: false, pinned: null });
    expect(plan.note).toMatch(/"Works on" setting is Off/);
    expect(plan.note).toMatch(/no computer and no built-in browser/);
    // the same whether or not a browser could have been mounted
    expect(resolveSurface({ destination: "off", browserOn: false })).toEqual(plan);
    // nothing mounted, so the surface paragraph stays silent and only the
    // note tells the model why it has no screen
    expect(surfacePrompt({ computer: null, browser: false }, { note: plan.note })).toBe(plan.note);
  });

  it("Off is the one setting a conversation pin cannot override", () => {
    expect(resolveSurface({ destination: "off", pinnedSurface: "browser", browserOn: true }))
      .toMatchObject({ computer: "off", browser: false, pinned: null });
    expect(resolveSurface({ destination: "off", pinnedSurface: "vm", browserOn: true }))
      .toMatchObject({ computer: "off", browser: false, pinned: null });
  });

  it("a conversation pin wins over the bot's default, whatever that default is", () => {
    // pinned to the browser from the composer while the bot defaults to a computer
    expect(resolveSurface({ destination: "vm", pinnedSurface: "browser", browserOn: true }))
      .toEqual({ computer: "off", browser: true, pinned: "browser", note: "" });
    // pinned to a computer while the bot is browser-only or on Auto
    for (const destination of ["browser", undefined] as const) {
      for (const pin of ["vm", "local"] as const) {
        expect(resolveSurface({ destination, pinnedSurface: pin, browserOn: true }))
          .toEqual({ computer: pin, browser: false, pinned: pin, note: "" });
      }
    }
  });

  it("keeps an unavailable browser pin instead of silently moving to another computer", () => {
    for (const destination of [undefined, "local", "vm", "browser"] as const) {
      expect(resolveSurface({ destination, pinnedSurface: "browser", browserOn: false }))
        .toMatchObject({ computer: "off", browser: false, pinned: "browser",
          note: expect.stringMatching(/No computer is mounted instead/) });
    }
  });

  it("Auto without a pin leaves the computer to the dispatch and keeps the browser as its fallback", () => {
    expect(resolveSurface({ destination: undefined, browserOn: true })).toEqual({
      computer: undefined,
      browser: true,
      pinned: null,
      note: "",
    });
    expect(resolveSurface({ destination: undefined, browserOn: false })).toMatchObject({ computer: undefined, browser: false });
  });
});

describe("surfacePrompt", () => {
  it("names both surfaces and splits the work when both are mounted", () => {
    const text = surfacePrompt({ computer: "vm", browser: true });
    expect(text).toMatch(/Two surfaces are mounted/);
    expect(text).toMatch(/Web tasks → the built-in browser/);
    expect(text).toMatch(/Desktop apps, files and shell → the Local VM tools/);
    expect(text).toMatch(/Pick one surface for a task and stay on it/);
    expect(text).toMatch(/say which surface — the Browser tab or the Local VM/);
  });

  it("names only the computer when it is the only surface", () => {
    const text = surfacePrompt({ computer: "vm", browser: false });
    expect(text).toMatch(/happens on the Local VM, web pages included/);
    expect(text).toMatch(/no separate built-in browser/);
    expect(text).toMatch(/say in one short sentence where you are working/);
    expect(text).not.toMatch(/Two surfaces/);
    expect(surfacePrompt({ computer: "local", browser: false })).toMatch(/tell them it is on this computer/);
  });

  it("names only the browser tab when it is the only surface", () => {
    const text = surfacePrompt({ computer: null, browser: true });
    expect(text).toMatch(/happens in the built-in browser tab/);
    expect(text).toMatch(/no desktop, file or shell computer/);
    expect(text).toMatch(/Browser tab of the Computer panel/);
    expect(text).toMatch(/say in one short sentence where you are working/);
    expect(text).not.toMatch(/happens on the Local VM/);
  });

  it("explains unavailable tools, and carries the pin line and the note", () => {
    expect(surfacePrompt({ computer: null, browser: false })).toContain("No computer or built-in browser tools are mounted");
    expect(surfacePrompt({ computer: "vm", browser: false }, { pinned: "vm" }))
      .toContain("This conversation is pinned to the Local VM; changing places requires");
    expect(surfacePrompt({ computer: null, browser: false }, { note: " NOTE." })).toBe(" NOTE.");
  });

  it.each(["local", "vm", "browser"] as const)("requires observed results on the actual %s tools", (place) => {
    const text = surfacePrompt({ computer: place === "browser" ? null : place, browser: place === "browser" });
    expect(text).toContain("verify its result before claiming success");
    expect(text).toContain("Announcing an action is not performing it");
    expect(text).toContain("never act on a different computer or describe a host window as a VM");
    expect(text).toContain("use Colonie's mounted browser/computer tools first");
    expect(text).toContain("Do not substitute the provider's own desktop");
  });

  it("chooses and starts configured targets through chat instead of requiring menu nudges", () => {
    const text = surfacePrompt({ computer: null, browser: false }, { canSelect: true });
    expect(text).toContain("use select_computer with no arguments");
    expect(text).toContain("surface auto instead of asking them to operate the menu");
    expect(text).toContain("highlight the selected target");
    expect(text).toContain("when it needs desktop apps or capabilities the current Browser lacks, select an available Local VM");
    expect(text).toContain("then you must carry out the task");
    expect(text).not.toContain("ask the user to choose and connect a computer");
  });

  it("keeps explicit destinations and uses a turn-bound switch when supported", () => {
    const text = surfacePrompt({ computer: "local", browser: false }, { pinned: "local", canSelect: true });
    expect(text).toContain("select the requested available place");
    expect(text).toContain("changing places requires select_computer");
    expect(text).toContain("Never silently replace an explicitly requested VM with the host desktop");
    expect(text).not.toContain("ask the user to change where this conversation works");
  });

  it("sends the person to the Computer panel, the place control both interface modes show", () => {
    const text = surfacePrompt({ computer: "vm", browser: false }, { pinned: "vm" });
    expect(text).toContain("explain the mismatch and ask the user to change where this conversation works in the Computer panel");
    expect(text).toContain("changing places requires the user's choice in the Computer panel, not a different tool name");
    // Simple mode has no composer chip, so no selector the person cannot see.
    expect(text).not.toContain("computer selector");
  });

  it("keeps this computer's host and the Local VM apart in the authority paragraph", () => {
    expect(surfacePrompt({ computer: "vm", browser: true }, { canSelect: true }))
      .toContain("this computer is the user's host, Local VM is an isolated desktop");
  });
});

describe("surface parsing", () => {
  it("accepts only the three surfaces off the wire", () => {
    expect(parseSurface("browser")).toBe("browser");
    expect(parseSurface("vm")).toBe("vm");
    expect(parseSurface("local")).toBe("local");
    expect(parseSurface("cloud")).toBeUndefined();
    expect(parseSurface("box")).toBeUndefined();
    expect(parseSurface(42)).toBeUndefined();
    expect(parseSurface(undefined)).toBeUndefined();
  });

  it("folds a dispatch's computer kind into the same surface", () => {
    expect(surfaceOfComputerKind("vm")).toBe("vm");
    expect(surfaceOfComputerKind("local")).toBe("local");
    expect(surfaceOfComputerKind(null)).toBeNull();
  });
});

it("does not instruct use of a selected browser when no surface is mounted", () => {
  expect(surfacePrompt({ computer: null, browser: false }, { canSelect: true })).not.toContain("For online research");
  expect(surfacePrompt({ computer: null, browser: true })).toContain("For online research");
});

describe("computerToolsReason", () => {
  it("refuses a Tool selection without the computer with one action: the setting that changes it", () => {
    const line = "Scout's tool selection leaves out the computer server, so no computer is available; turn the computer tools on in Access settings, or use the built-in browser.";
    expect(computerToolsReason({ deny: ["mcp:computer:*"] }, "Scout")).toBe(line);
    expect(computerToolsReason({ allow: ["native:*"] }, "Scout")).toBe(line);
  });

  it("lets every selection that keeps a computer tool through", () => {
    expect(computerToolsReason(undefined, "Scout")).toBeNull();
    expect(computerToolsReason({ allow: ["native:*", "mcp:computer:screenshot"] }, "Scout")).toBeNull();
    expect(computerToolsReason({ deny: ["mcp:computer:exec"] }, "Scout")).toBeNull();
  });
});

describe("placeUnavailable", () => {
  it("carries the row's English line and its one next action, uncut", () => {
    expect(placeUnavailable("vm", { state: "vm-cannot", params: { bot: "Scout", model: "Llama" }, source: "works-on" }))
      .toMatchObject({
        name: "PlaceUnavailableError",
        place: "vm",
        row: { state: "vm-cannot", params: { bot: "Scout", model: "Llama" }, source: "works-on" },
        message: "Llama can't use a Local VM. Choose a model that can, such as Claude or ChatGPT. Choose another model in Scout's settings.",
      });
    expect(placeUnavailable("vm", { state: "place-failed", params: { bot: "Scout", cause: "The Local VM is not ready." }, source: "works-on" }))
      .toMatchObject({ name: "PlaceUnavailableError", place: "vm", message: "The Local VM is not ready. Check it in the Computer panel." });
  });

  it("keeps the whole cause: no row cuts it", () => {
    const long = `${"x".repeat(400)}.`;
    expect(placeUnavailable("vm", { state: "place-failed", params: { bot: "Scout", cause: long }, source: "works-on" }).message)
      .toBe(`${long} Check it in the Computer panel.`);
  });
});