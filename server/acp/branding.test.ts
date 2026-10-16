import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { colonieDataDir, colonieUserData, initializeColonieData } from "../../electron/colonie-config.mjs";
import { removeTempDir } from "../testing/cleanup.ts";

it("resolves the data and profile dirs under the user's home, with environment overrides", async () => {
  const root = mkdtempSync(join(tmpdir(), "colonie-branding-"));
  try {
    expect(colonieDataDir(root, {})).toBe(join(root, ".colonie"));
    expect(colonieUserData(root, {})).toBe(join(root, "Colonie"));
    expect(colonieDataDir(root, { COLONIE_DATA_DIR: join(root, "explicit") })).toBe(join(root, "explicit"));
    expect(colonieUserData(root, { COLONIE_USER_DATA: join(root, "profile") })).toBe(join(root, "profile"));

    const data = join(root, ".colonie");
    mkdirSync(data);
    const config = JSON.stringify({ instances: { "codex-acp": { driver: "codex-acp" } }, example: "preserve" });
    writeFileSync(join(data, "config.json"), config);
    initializeColonieData(data);
    expect(readFileSync(join(data, "config.json"), "utf8")).toBe(config);
  } finally { await removeTempDir(root); }
});