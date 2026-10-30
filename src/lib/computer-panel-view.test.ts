// One Computer panel: a bot with no desktop shows its browser, never an
// empty Desktop tab; a bot with one keeps it.
import { expect, test } from "vitest";

import { offersBrowserTab, shownComputerPanelView } from "./computer-panel-view";

const simple = { advanced: false, hasDesktop: false };

test("the Computer tab is always there, where a person gives the bot a computer", () => {
  expect(shownComputerPanelView("computer", simple)).toBe("computer");
  expect(shownComputerPanelView("android", simple)).toBe("computer");
  expect(shownComputerPanelView("browser", simple)).toBe("browser");
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

test("an old Routines tab preference opens the computer with its inline routines", () => {
  expect(shownComputerPanelView("routines", simple)).toBe("computer");
  expect(shownComputerPanelView("routines", { ...simple, advanced: true })).toBe("computer");
});
