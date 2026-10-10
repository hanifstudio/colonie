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
}
