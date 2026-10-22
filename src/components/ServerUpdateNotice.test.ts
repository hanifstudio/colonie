// On a Shared workspace whose server has a newer version published, its
// admins see it in the sidebar and update with one click.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { ServerUpdateNoticeView } from "./ServerUpdateNotice";

const view = (props: Partial<Parameters<typeof ServerUpdateNoticeView>[0]>) => renderToStaticMarkup(createElement(ServerUpdateNoticeView, {
  status: { supported: true, current: "0.2.0", latest: "0.2.1", available: true, requested: null }, updating: false, error: "", onUpdate: () => {}, ...props,
}));

test("a newer version shows with Update", () => {
  const html = view({});
  expect(html).toContain("Colonie 0.2.1 is available");
  expect(html).toContain("Update");
});

test("while it updates, it says the workspace restarts", () => {
  expect(view({ updating: true })).toMatch(/restarts in about a minute/);
});

test("nothing newer, or no updates from the app, shows nothing", () => {
  expect(view({ status: { supported: true, current: "0.2.1", latest: "0.2.1", available: false, requested: null } })).toBe("");
  expect(view({ status: null })).toBe("");
});
