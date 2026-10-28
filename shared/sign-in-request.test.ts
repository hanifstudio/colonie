// A sign-in card opens only a plain web page, and names its site plainly.
import { expect, test } from "vitest";

import { normalizeSignInSite, signInResumeText } from "./sign-in-request.ts";

test("a domain or web address becomes a page and the site shown on the card", () => {
  expect(normalizeSignInSite("redbus.id")).toEqual({ url: "https://redbus.id/", site: "redbus.id" });
  expect(normalizeSignInSite("https://www.redbus.id/bus-tickets")).toEqual({ url: "https://www.redbus.id/bus-tickets", site: "redbus.id" });
});

test("anything that is not a plain web page is refused", () => {
  for (const raw of ["javascript:alert(1)", "file:///etc/passwd", "https://user:pw@example.com", "example", "", 42, "exa mple.com"]) {
    expect(normalizeSignInSite(raw)).toBeNull();
  }
});

test("the person's words resume the bot", () => {
  expect(signInResumeText("redbus.id", "done")).toBe("I finished on redbus.id. Please check and continue.");
  expect(signInResumeText("redbus.id", "cancelled")).toContain("Continue without it");
});
