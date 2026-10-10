import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { BloubAvatar, bloubState, bloubShape } from "./BloubAvatar";

it("renders independent SVG masks and stable frames for concurrent static avatars", () => {
  const html = renderToStaticMarkup(createElement("div", null,
    createElement(BloubAvatar, { color: "green", animated: false, size: 24, label: "A" }),
    createElement(BloubAvatar, { color: "blue", animated: false, size: 24, label: "B" })));
  const ids = [...html.matchAll(/<mask id="([^"]+)"/g)].map((match) => match[1]);
  expect(ids).toHaveLength(2);
  expect(new Set(ids).size).toBe(2);
  expect(html).not.toContain("NaN");
  expect(html).toContain('data-mascot="bloub"');
  expect(html).toContain('aria-label="A"');
});

it("maps old status/body vocabulary without losing the agent activity meaning", () => {
  expect(bloubState("working")).toBe("orbit");
  expect(bloubState("thinking")).toBe("thinking");
  expect(bloubState("alerting")).toBe("notify");
  expect(bloubState("idle", "failure")).toBe("alert");
  expect(bloubShape("cursor").id).toBe("galet");
  expect(bloubShape("unknown").id).toBe("galet");
  expect(bloubShape("drop").id).toBe("goutte");
});
