import { describe, expect, it } from "vitest";
import { commitProblems, needsCodeChecks } from "../commit-guard.mjs";

const text = (files) => (path) => files[path] ?? "";

describe("the commit guard", () => {
  it("refuses a deleted test file but allows a renamed one", () => {
    expect(commitProblems([{ status: "D", path: "server/acp/profile.test.ts" }], text({}))).toHaveLength(1);
    expect(commitProblems([{ status: "D", path: "electron/preload.node-test.mjs" }], text({}))).toHaveLength(1);
    expect(commitProblems([{ status: "R", path: "server/acp/renamed.test.ts" }], text({}))).toEqual([]);
    expect(commitProblems([{ status: "D", path: "server/old-module.ts" }], text({}))).toEqual([]);
  });

  it("refuses a new document but allows editing the existing ones", () => {
    expect(commitProblems([{ status: "A", path: "docs/NOTES.md" }], text({}))).toHaveLength(1);
    expect(commitProblems([{ status: "M", path: "docs/HANDOVER.md" }], text({ "docs/HANDOVER.md": "# Handover\n" }))).toEqual([]);
  });

  it("refuses invented codes in the docs and allows plain words", () => {
    const bad = { "AGENTS.md": "Finish E02.4b2a, then S3.37 and L1." };
    expect(commitProblems([{ status: "M", path: "AGENTS.md" }], text(bad))[0]).toMatch(/E02\.4b2a, S3\.37, L1/);
    const fine = { "AGENTS.md": "Create and switch workspaces. Node 24, version 0.2.0, port 8799." };
    expect(commitProblems([{ status: "M", path: "AGENTS.md" }], text(fine))).toEqual([]);
  });

  it("does not look for codes in source files", () => {
    expect(commitProblems([{ status: "M", path: "server/x.ts" }], text({ "server/x.ts": "// E02.4" }))).toEqual([]);
  });

  it("counts a HANDOVER of exactly 100 lines, ending in a newline, as 100", () => {
    const full = { "docs/HANDOVER.md": "line\n".repeat(100) };
    expect(commitProblems([{ status: "M", path: "docs/HANDOVER.md" }], text(full))).toEqual([]);
  });

  it("refuses a HANDOVER over 100 lines", () => {
    const long = { "docs/HANDOVER.md": "line\n".repeat(120) };
    expect(commitProblems([{ status: "M", path: "docs/HANDOVER.md" }], text(long))[0]).toMatch(/limit 100/);
  });

  it("runs the code checks unless only documentation changed", () => {
    expect(needsCodeChecks([{ status: "M", path: "docs/HANDOVER.md" }])).toBe(false);
    expect(needsCodeChecks([{ status: "M", path: "server/index.ts" }])).toBe(true);
    expect(needsCodeChecks([{ status: "D", path: "server/old.ts" }])).toBe(false);
  });
});
