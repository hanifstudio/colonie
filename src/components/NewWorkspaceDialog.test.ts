// New workspace, from the one workspace list: Local (a name, then it opens
// and its own onboarding starts) or Shared (its onboarding).
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { NewWorkspaceView } from "./NewWorkspaceDialog";

const view = (props: Partial<Parameters<typeof NewWorkspaceView>[0]>) => renderToStaticMarkup(createElement(NewWorkspaceView, {
  kind: "local", name: "", busy: false, error: "", notice: "", onKind: () => {}, onName: () => {}, onCreate: () => {}, onClose: () => {}, ...props,
}));

test("it asks the kind first: Local or Shared", () => {
  const html = view({});
  expect(html).toContain("New workspace");
  expect(html).toContain("Local");
  expect(html).toContain("Shared");
});

test("Local asks a name and says its onboarding follows", () => {
  const html = view({ kind: "local" });
  expect(html).toContain("Workspace name");
  expect(html).toMatch(/set up from the start/i);
  expect(html).toContain("Create");
});

test("Shared goes on to its onboarding", () => {
  const html = view({ kind: "shared" });
  expect(html).not.toContain("Workspace name");
  expect(html).toContain("Continue");
});
