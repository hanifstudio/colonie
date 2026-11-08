// A bot's face: the same default everywhere, and only a feeling changes it.
import { expect, test } from "vitest";
import { bloubFace } from "./BloubAvatar";

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
