// The sign-in page a browser gets on a Shared workspace it is not signed in
// to, and the decision that shows it.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { firstScreen } from "@/lib/session";
import { COLONIE_SIGN_IN_PATH, SignInPage } from "./SignInPage";

test("someone the server does not know gets the sign-in page; everyone else the app", () => {
  expect(firstScreen({ kind: "unauthenticated", error: "403" })).toBe("sign-in");
  expect(firstScreen({ kind: "loopback" })).toBe("app");
  expect(firstScreen({ kind: "session", id: "s", label: "", scopes: ["client"], expiresAt: 0 })).toBe("app");
  expect(firstScreen({ kind: "unreachable", error: "offline" })).toBe("app");
});

test("a workspace connected to Colonie offers Sign in with Colonie", () => {
  const html = renderToStaticMarkup(createElement(SignInPage, { colonieSignIn: true, workspace: "Launch Team" }));
  expect(html).toContain("Sign in to Launch Team");
  expect(html).toContain(`href="${COLONIE_SIGN_IN_PATH}"`);
  expect(html).toContain("Sign in with Colonie");
});

test("a workspace without Colonie sign-in says how to get in instead", () => {
  const html = renderToStaticMarkup(createElement(SignInPage, { colonieSignIn: false, workspace: "Launch Team" }));
  expect(html).not.toContain(COLONIE_SIGN_IN_PATH);
  expect(html).toContain("invite link");
});
