// Exact app-owned browser state that belongs in an encrypted full backup.
// Never include cookies, authentication tokens, connection caches or unknown keys.
export const WORKSPACE_BACKUP_CLIENT_KEYS = [
  "colonie-drafts",
  "colonie-draft-attachments",
  "colonie-draft-send-ids",
  "colonie-draft-channel-modes",
  "colonie-skin",
  "colonie-show-threads",
  "colonie-show-run-card",
  "colonie.sidebarDensity",
  "colonie.sidebarCollapsedSections.v1",
  "colonie.sidebarSectionOrder.v1",
  "colonie-analytics-opt-out",
  "colonie.remote-voice.v1",
] as const;

export type WorkspaceBackupClientState = Partial<Record<(typeof WORKSPACE_BACKUP_CLIENT_KEYS)[number], string>>;
