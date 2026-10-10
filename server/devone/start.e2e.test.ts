import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { removeTempDir, waitForExit } from "../testing/cleanup.ts";

it("boots the documented source launcher with valid isolated Codex defaults", async () => {
  const root = mkdtempSync(join(tmpdir(), "devone-launcher-check-"));
  const child = spawn(process.execPath, [join(import.meta.dirname, "../../scripts/devone/start.ts"), "--web"], {
    cwd: join(import.meta.dirname, "../.."),
    env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root, OMB_DATA_DIR: join(root, "data") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    await expect.poll(() => {
      if (child.exitCode !== null) throw new Error(`Launcher exited: ${stderr}`);
      return stdout.match(/Colonie: (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    }, { timeout: 30_000 }).toBeTruthy();
    const ui = stdout.match(/Colonie: (http:\/\/127\.0\.0\.1:\d+)/)![1]!;
    const response = await fetch(`${ui}/api/instances`);
    expect(response.ok).toBe(true);
    const instances = (await response.json() as { instances: Array<{ driverKind: string }> }).instances;
    expect(instances.map((entry: any) => entry.driverKind)).toEqual(["codex-acp", "claude-acp"]);
    const config = JSON.parse(readFileSync(join(root, "data", "config.json"), "utf8"));
    expect(config.defaultModelSelection.instanceId).toBe("codex-acp");
    expect(config.onboarding.hintsSeen).toContain("tour.done");
    expect(stderr).not.toContain("using defaults");
  } finally {
    await waitForExit(child, { signal: "SIGINT" });
    await removeTempDir(root);
  }
}, 45_000);
