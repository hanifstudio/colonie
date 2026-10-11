import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { BotEngine } from "../../third_party/bloub/src/bot/engine";
import { BloubAvatar, BloubFrame, bloubState, bloubShape } from "./BloubAvatar";

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

it("renders the global-gaze variant without crashing outside a browser", () => {
  const html = renderToStaticMarkup(
    createElement(BloubAvatar, { color: "yellow", animated: true, size: 64, label: "Yuki", followGlobalPointer: true }));
  expect(html).toContain('data-mascot="bloub"');
  expect(html).toContain('aria-label="Yuki"');
});

it("frames resting bodies tight and decor arcs full", () => {
  const idle = new BotEngine(100, "idle").sample(1);
  expect(idle.arcs.filter((arc) => arc.opacity > 0.02)).toHaveLength(0);
  const idleHtml = renderToStaticMarkup(
    createElement(BloubFrame, { frame: idle, size: 64, ink: "#e4c979", uid: "tight", label: "Yuki" }));
  expect(idleHtml).toContain('viewBox="-120 -120 240 240"');
  const orbit = new BotEngine(100, "orbit").sample(1.5);
  expect(orbit.arcs.some((arc) => arc.opacity > 0.02)).toBe(true);
  const orbitHtml = renderToStaticMarkup(
    createElement(BloubFrame, { frame: orbit, size: 64, ink: "#e4c979", uid: "full", label: "Yuki" }));
  expect(orbitHtml).toContain('viewBox="-158 -158 316 316"');
});
