// A bot's face: the same default everywhere, and only a feeling changes it.
import { expect, test } from "vitest";
import { bloubFace, PICKABLE_BODY_IDS } from "./BloubAvatar";
import { stateForBot } from "@/lib/mascot";

test("a bot reads the same on every screen: states that are not a feeling keep the default face", () => {
  const rest = bloubFace("idle");
  expect(rest).toBe("excite");
  for (const state of ["working", "thinking", "searching", "sleeping", "writing", "notifying"]) expect(bloubFace(state)).toBe(rest);
});

test("a state that is itself a feeling changes the face", () => {
  for (const state of ["sad", "scared", "angry", "listening", "surprised"]) expect(bloubFace(state), state).not.toBe(bloubFace("idle"));
});

test("every body the picker offers is drawn differently, and a retired one maps to its twin", async () => {
  const { PICKABLE_BODY_IDS, bodyChoice, bloubShape } = await import("./BloubAvatar");
  const shapes = PICKABLE_BODY_IDS.map((id) => bloubShape(id));
  expect(new Set(shapes).size).toBe(shapes.length);
  expect(bodyChoice("blob")).toBe("cursor");
  expect(bodyChoice("shield")).toBe("drop");
  expect(bodyChoice("diamond")).toBe("squircle");
  expect(bodyChoice(undefined)).toBe("cursor");
});

test("a bot at rest is idle whatever its title says; only what it is doing changes it", () => {
  for (const title of ["Job Search Partner", "Software engineer", "Overnight batch runner", "Security and finance"]) {
    expect(stateForBot({ name: "Bot", title }), title).toBe("idle");
  }
  expect(stateForBot({ name: "Bot", title: "Job Search Partner", busy: true })).toBe("working");
});

test("the body picker offers the triangle and fills a 4 by 2 grid", () => {
  expect(PICKABLE_BODY_IDS).toContain("triangle");
  expect(PICKABLE_BODY_IDS).toHaveLength(8);
});
