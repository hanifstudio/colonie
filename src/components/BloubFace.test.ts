// A bot's face: the one its owner chose wins everywhere, and the picker offers only faces that differ.
import { expect, test } from "vitest";
import { PICKABLE_STATES, stateForBot } from "@/lib/mascot";
import { bloubFace } from "./BloubAvatar";

test("the chosen face wins over what the state suggests", () => {
  expect(bloubFace("working", "sad")).toBe(bloubFace("idle", "sad"));
  expect(bloubFace("idle", "sad")).not.toBe(bloubFace("idle"));
});

test("a bot without a chosen face reads the same on every screen", () => {
  const rest = bloubFace("idle");
  for (const state of ["happy", "working", "thinking", "searching", "sleeping"]) expect(bloubFace(state)).toBe(rest);
});

test("a chosen face never turns into a movement", () => {
  expect(stateForBot({ name: "Ada", mascotExpression: "thinking" })).toBe("idle");
});

test("every face the picker offers looks different", () => {
  const faces = PICKABLE_STATES.map((state) => bloubFace(state));
  expect(new Set(faces).size).toBe(faces.length);
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
