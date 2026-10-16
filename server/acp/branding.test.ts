import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { colonieDataDir, colonieUserData, initializeColonieData } from "../../electron/colonie-config.mjs";
import { removeTempDir } from "../testing/cleanup.ts";

it("keeps legacy Colonie data/profile paths byte-for-byte and uses new paths for fresh installs", async () => {
  const root = mkdtempSync(join(tmpdir(), "colonie-branding-"));
  try {
    expect(colonieDataDir(root, {})).toBe(join(root, ".colonie"));
    expect(colonieUserData(root, {})).toBe(join(root, "Colonie"));
    const data = join(root, ".colonie-dev"); mkdirSync(data);
    const config = JSON.stringify({ instances: { "codex-acp": { driver: "codex-acp" } }, example: "preserve" });
    writeFileSync(join(data, "config.json"), config);
    mkdirSync(join(root, "Colonie"));
    expect(colonieDataDir(root, {})).toBe(data);
    expect(colonieUserData(root, {})).toBe(join(root, "Colonie"));
    initializeColonieData(data);
    expect(readFileSync(join(data, "config.json"), "utf8")).toBe(config);
    expect(colonieDataDir(root, { COLONIE_DATA_DIR: join(root, "explicit") })).toBe(join(root, "explicit"));
  } finally { await removeTempDir(root); }
});
