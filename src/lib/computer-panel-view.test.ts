// One Computer panel: a bot with no desktop shows its browser, never an
// empty Desktop tab; a bot with one keeps it.
import { expect, test } from "vitest";

import { offersBrowserTab, shownComputerPanelView } from "./computer-panel-view";

const simple = { advanced: false, hasDesktop: false, browser: true };

test("a bot without a desktop shows its browser, or its files with no browser", () => {
  expect(shownComputerPanelView("computer", simple)).toBe("browser");
  expect(shownComputerPanelView("android", simple)).toBe("browser");
  expect(shownComputerPanelView("computer", { ...simple, browser: false })).toBe("files");
  expect(shownComputerPanelView("files", simple)).toBe("files");
});

test("a bot with a desktop sees it, and its browser is on that desktop", () => {
  expect(shownComputerPanelView("browser", { ...simple, hasDesktop: true })).toBe("computer");
  expect(offersBrowserTab({ advanced: false, hasDesktop: true })).toBe(false);
  expect(offersBrowserTab({ advanced: false, hasDesktop: false })).toBe(true);
});

test("a bot with a desktop, or Advanced mode, keeps the Desktop tab", () => {
  expect(shownComputerPanelView("computer", { ...simple, hasDesktop: true })).toBe("computer");
  expect(shownComputerPanelView("computer", { ...simple, advanced: true })).toBe("computer");
  expect(shownComputerPanelView("files", { ...simple, advanced: true })).toBe("computer");
});
