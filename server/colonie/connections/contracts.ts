import type { McpServer } from "@agentclientprotocol/sdk";
import type { ConnectedToolsReceipt } from "../../../shared/connected-apps.ts";

/** Provider-neutral app-selected tools. Secrets are not part of public metadata. */
export interface AcpToolMount {
  servers: McpServer[];
  revision: string;
  receipt: ConnectedToolsReceipt;
  activate(): void;
  deactivate(): void;
  release(): void;
  calls(): import("../../../shared/connected-apps.ts").ConnectedToolCall[];
  /** Tools of this mount that never need the engine's permission prompt:
   * Colonie's own, each confirmed by its own card or Undo. */
  trustedTools?: readonly string[];
  /** Servers of this mount whose every tool runs without the engine's
   * prompt: the bot's own computer, where the person can take over. */
  trustedServers?: readonly string[];
}
