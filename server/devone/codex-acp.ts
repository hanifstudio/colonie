import { createAcpProvider } from "./acp-runtime.ts";
export { AcpRuntime as CodexAcpAdapter } from "./acp-runtime.ts";
export const CodexAcpDriver = createAcpProvider({
  kind: "codex-acp", name: "Codex", version: "2.1.1",
  packageEntry: "@agentclientprotocol/codex-acp", entryEnvironment: "DEVONE_ACP_ENTRY",
  loginCommand: "codex login", askMode: "read-only", fullMode: "agent-full-access",
});
