// The first screen of the desktop app until the person has a Colonie account:
// sign up or in once, in the browser; then the app as usual, offline too.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { AccountGateView, needsAccount } from "./AccountGate";

const view = (extra: Partial<Parameters<typeof AccountGateView>[0]> = {}) =>
  renderToStaticMarkup(createElement(AccountGateView, { waiting: false, busy: false, error: "", onStart: () => {}, ...extra }));

test("it asks for an account only when this computer has none", () => {
  expect(needsAccount({ status: 200, body: { required: true, account: null } })).toBe(true);
  expect(needsAccount({ status: 200, body: { required: true, account: { email: "a@x.com", name: "A" } } })).toBe(false);
  // No account route (a Shared workspace's page), or Colonie's own server
  // not answering: never lock the person out of their own computer.
  expect(needsAccount({ status: 404, body: null })).toBe(false);
  expect(needsAccount(null)).toBe(false);
});

test("the screen says why and offers one button", () => {
  const html = view();
  expect(html).toContain("Welcome to Colonie");
  expect(html).toMatch(/Colonie account/);
  expect(html).toMatch(/every Shared workspace/);
  expect(html).toContain("Sign up or sign in");
  expect(html).not.toMatch(/Finish in the Colonie account window/);
});

test("while the browser is open it says so, and a failure says why", () => {
  expect(view({ waiting: true })).toMatch(/Finish in the Colonie account window/);
  expect(view({ error: "Colonie accounts cannot be reached right now." })).toContain("cannot be reached");
});
