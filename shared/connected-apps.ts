export interface ConnectedAppsPolicy { toolkits: string[]; customServers: string[] }
export interface ConnectedAppsView extends ConnectedAppsPolicy { revision: string; configured: boolean }
export interface ConnectedToolsReceipt {
  policyHash: string;
  servers: Array<{ name: string; source: "composio" | "custom"; transport: "stdio" | "http" | "sse" }>;
  composioToolkits: string[];
}
export interface ConnectedToolCall {
  server: string;
  tool: string;
  targets: string[];
  status: "started" | "completed" | "failed" | "cancelled";
}
