import { expect, test } from "vitest";
import { readBotPanelView, writeBotPanelView } from "./bot-panel-view";

const read = (value: string | null) => readBotPanelView("bot", { getItem: () => value });

test("the browser is the default panel", () => {
  expect(read(null)).toBe("browser");
  expect(read("browser")).toBe("browser");
});
test("retired desktop, device, and routine views reopen the browser", () => {
  for (const old of ["computer", "android", "routines", "unknown"]) expect(read(old)).toBe("browser");
});
test("the files preference survives the removal of desktop control", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  writeBotPanelView("bot", "files", storage);
  expect(readBotPanelView("bot", storage)).toBe("files");
  expect(readBotPanelView("other", storage)).toBe("browser");
});
test("blocked storage never prevents opening the browser", () => {
  expect(readBotPanelView("bot", { getItem: () => { throw new Error("blocked"); } })).toBe("browser");
  expect(() => writeBotPanelView("bot", "browser", { setItem: () => { throw new Error("blocked"); } })).not.toThrow();
});
