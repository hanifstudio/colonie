import type { AcpContextManifest } from "./acp-context.ts";
/** Application-authored input only. The provider owns native system/project context. */
export interface AcpInputReceipt {
  id: string;
  at: string;
  threadId: string;
  turnId: string;
  instanceId: string;
  sessionId: string;
  cwd: string;
  model: string;
  mode: string;
  instructions: string;
  prompt: Array<{ type: "text"; text: string } | { type: "image"; mimeType: string; data: string }>;
  status: "dispatching" | "completed" | "cancelled" | "failed";
  error?: string;
  nativeSettings?: Record<string, string | boolean>;
  context?: AcpContextManifest;
  connectedTools?: import("./connected-apps.ts").ConnectedToolsReceipt;
  connectedToolCalls?: import("./connected-apps.ts").ConnectedToolCall[];
}

export const DEVONE_DRIVER = "codex-acp";
export const COLONIE_ACP_DRIVERS = ["codex-acp", "claude-acp"] as const;
export function isColonieAcpDriver(driver?: string): boolean {
  return COLONIE_ACP_DRIVERS.some((kind) => kind === driver);
}
