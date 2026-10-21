// Which welcome steps a person sees.
import { expect, test } from "vitest";

import { beatsFor } from "./onboarding";

test("someone signed in to a Colonie account is not asked their name and email again", () => {
  expect(beatsFor({ dictation: false, reel: false, signedIn: true })).toEqual(["workspace", "engines", "bot"]);
  expect(beatsFor({ dictation: false, reel: false })).toEqual(["hello", "workspace", "engines", "bot"]);
});
