import { expect, test } from "vitest";
import { firstBotPanelView, readBotPanelView, writeBotPanelView } from "./bot-panel-view";

const read = (value: string | null) => readBotPanelView("bot", { getItem: () => value });

test("nothing is chosen until a person chooses, and each of the three tabs is remembered", () => {
  expect(read(null)).toBeUndefined();
  for (const view of ["screen", "browser", "files"]) expect(read(view)).toBe(view);
});
test("retired desktop, device, and routine views are forgotten", () => {
  for (const old of ["computer", "android", "routines", "unknown"]) expect(read(old)).toBeUndefined();
});
test("each bot keeps its own tab", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  writeBotPanelView("bot", "files", storage);
  expect(readBotPanelView("bot", storage)).toBe("files");
  expect(readBotPanelView("other", storage)).toBeUndefined();
});
test("blocked storage never prevents opening the panel", () => {
  expect(readBotPanelView("bot", { getItem: () => { throw new Error("blocked"); } })).toBeUndefined();
  expect(() => writeBotPanelView("bot", "browser", { setItem: () => { throw new Error("blocked"); } })).not.toThrow();
});
test("a panel opens on the Screen, or on the Browser where the server cannot run a computer", () => {
  expect(firstBotPanelView(true)).toBe("screen");
  expect(firstBotPanelView(false)).toBe("browser");
});
