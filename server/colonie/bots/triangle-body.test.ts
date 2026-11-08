import { expect, test } from "vitest";
import { parseBotProfilePatch } from "./bot-profile.ts";

test("the server accepts every body the picker offers, including Triangle", async () => {
  const { PICKABLE_BODY_IDS } = await import("../../../shared/mascot-bodies.ts");
  for (const id of PICKABLE_BODY_IDS) expect(parseBotProfilePatch({ mascotBody: id }, true).ok, id).toBe(true);
});
