import { describe, expect, it } from "vitest";
import { applyWorkspaceClientState, collectWorkspaceClientState } from "./workspace-backup-client";

function memory(values: Record<string, string>) {
  const entries = new Map(Object.entries(values));
  return { entries, getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); }, removeItem: (key: string) => { entries.delete(key); } };
}

describe("full-backup browser state", () => {
  it("exports exact app drafts/preferences, never saved webhook credentials or auth/cache keys", () => {
    const storage = memory({ "colonie-drafts": "draft", "colonie-webhook-credentials": "private URL", "colonie-skin": "daylight", "auth-token": "secret", "colonie-connected-apps": "cached accounts", "colonie-email-gate": "identity", "colonie-pending-workspace-restore": "old" });
    expect(collectWorkspaceClientState(storage)).toEqual({ "colonie-drafts": "draft", "colonie-skin": "daylight" });
  });

  it("replaces only allowlisted keys and clears old drafts absent from the backup", () => {
    const storage = memory({ "colonie-drafts": "old", "colonie-draft-attachments": "old attachment", "auth-token": "keep", "colonie-webhook-credentials": "destination URL" });
    applyWorkspaceClientState({ "colonie-drafts": "restored", "colonie-show-threads": "false" }, storage);
    expect(Object.fromEntries(storage.entries)).toEqual({ "colonie-drafts": "restored", "colonie-show-threads": "false", "auth-token": "keep", "colonie-webhook-credentials": "destination URL" });
  });

  it("carries the run card visibility choice in a workspace backup", () => {
    const storage = memory({ "colonie-show-run-card": "0" });
    expect(collectWorkspaceClientState(storage)).toEqual({ "colonie-show-run-card": "0" });
    applyWorkspaceClientState({ "colonie-show-run-card": "1" }, storage);
    expect(storage.getItem("colonie-show-run-card")).toBe("1");
  });

  it.each([null, [], { "auth-token": "injected" }, { "colonie-webhook-credentials": "source URL" }, { "colonie-drafts": 1 }])("rejects invalid client state before clearing anything (%j)", (value) => {
    const storage = memory({ "colonie-drafts": "old", "auth-token": "keep" });
    expect(() => applyWorkspaceClientState(value, storage)).toThrow("Invalid backup browser state");
    expect(Object.fromEntries(storage.entries)).toEqual({ "colonie-drafts": "old", "auth-token": "keep" });
  });

  it("rolls browser state back if restored values exceed storage quota", () => {
    const storage = memory({ "colonie-drafts": "old", "colonie-skin": "daylight", "auth-token": "keep" });
    const original = storage.setItem;
    storage.setItem = (key, value) => { if (value === "too large") throw new Error("quota"); original(key, value); };
    expect(() => applyWorkspaceClientState({ "colonie-drafts": "too large" }, storage)).toThrow("quota");
    expect(Object.fromEntries(storage.entries)).toEqual({ "colonie-drafts": "old", "colonie-skin": "daylight", "auth-token": "keep" });
  });
});
