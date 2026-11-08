import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";
import { COLONIE_SCREEN_SCRIPT, LIGHT_XSTARTUP_SCRIPT, TOKEN_NOVNC_SCRIPT } from "./screen-scripts.ts";

const syntax = (name: string, script: string) => {
  const checked = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
  expect(checked.stderr, `${name} must parse`).toBe("");
  expect(checked.status).toBe(0);
};

test("the scripts baked into the image are valid shell", () => {
  syntax("colonie-screen", COLONIE_SCREEN_SCRIPT);
  syntax("start-novnc", TOKEN_NOVNC_SCRIPT);
  syntax("xstartup", LIGHT_XSTARTUP_SCRIPT);
});

test("a screen refuses numbers and names that could escape its paths", () => {
  const run = (...args: string[]) => spawnSync("bash", ["-c", COLONIE_SCREEN_SCRIPT.replace("state=/run/colonie", "state=$TMPDIR/colonie"), "x", ...args],
    { encoding: "utf8", env: { ...process.env, TMPDIR: process.env.TMPDIR ?? "/tmp" } });
  expect(run("up", "1", "tokentokentokentoken").status).toBe(2);
  expect(run("up", "2; rm -rf /", "tokentokentokentoken").status).toBe(2);
  expect(run("up", "2", "short").status).toBe(2);
  expect(run("up", "2", "tokentokentokentoken", "bot;id").status).toBe(2);
  expect(run("nonsense").status).toBe(2);
});

test("the viewer endpoint routes by token and serves the bundled page", () => {
  expect(TOKEN_NOVNC_SCRIPT).toContain("--token-plugin=TokenFile");
  expect(TOKEN_NOVNC_SCRIPT).toContain("/usr/share/novnc");
});
