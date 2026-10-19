// A workspace name and the answers a switch gives are the only things a person
// reads before the app restarts, so they are checked here instead of by eye.
import { describe, expect, it } from "vitest";
import { nameIssueMessage, switchNotice, switchRefusal, workspaceNameIssue } from "./local-workspaces.ts";

describe("what a typed workspace name still needs", () => {
  it("accepts a trimmed name up to the app's own bound", () => {
    expect(workspaceNameIssue("  Client work  ", 60)).toBe("");
    expect(workspaceNameIssue("x".repeat(60), 60)).toBe("");
  });

  it("asks for a name when there is nothing but spaces", () => {
    expect(workspaceNameIssue("", 60)).toBe("required");
    expect(workspaceNameIssue("   ", 60)).toBe("required");
  });

  it("refuses a name longer than the app allows, and says the bound", () => {
    expect(workspaceNameIssue("x".repeat(61), 60)).toBe("too-long");
    expect(nameIssueMessage("too-long", 60)).toContain("60");
    expect(nameIssueMessage("required", 60)).not.toContain("60");
  });
});

describe("what a workspace change says next", () => {
  it("names the workspace and the restart in the app that owns its server", () => {
    const notice = switchNotice("restart-app", "Client work");
    expect(notice).toContain("Client work");
    expect(notice).toContain("Colonie");
  });

  it("tells a source checkout to open Colonie again", () => {
    expect(switchNotice("reopen-colonie", "Client work")).toContain("Client work");
  });

  it("says nothing when that workspace is already the one running", () => {
    expect(switchNotice("already-open", "Client work")).toBe("");
  });
});

describe("why a change was refused", () => {
  it("answers each reason the app reports in its own words", () => {
    const answers = ["not-named", "not-listed", "in-use", "unwritable"].map((code) => switchRefusal(code));
    for (const answer of answers) expect(answer.length).toBeGreaterThan(0);
    expect(new Set(answers).size).toBe(4);
  });

  it("falls back to the app's own reason when this build does not know the code", () => {
    expect(switchRefusal("something-new", "the folder is read-only")).toBe("the folder is read-only");
    expect(switchRefusal(undefined, "   ")).toBe(switchRefusal(undefined));
    expect(switchRefusal("something-new", undefined).length).toBeGreaterThan(0);
  });
});
