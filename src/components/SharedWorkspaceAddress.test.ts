import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { SharedWorkspaceAddress } from "./SettingsModal";

test("only Shared workspaces show their browser address and a copy button", () => {
  const render = (shared: boolean) => renderToStaticMarkup(createElement(SharedWorkspaceAddress, {
    shared, origin: "https://team.example",
  }));
  expect(render(false)).toBe("");
  expect(render(true)).toContain("https://team.example");
  expect(render(true)).toContain("Copy workspace address");
  expect(render(true)).toContain("New members need an invitation");
});
