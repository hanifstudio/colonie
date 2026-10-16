import { createAcpProvider } from "./acp-runtime.ts";
export { AcpRuntime as CodexAcpAdapter } from "./acp-runtime.ts";
export const CodexAcpDriver = createAcpProvider({
  kind: "codex-acp", name: "Codex", version: "2.1.1",
  packageEntry: "@agentclientprotocol/codex-acp", entryEnvironment: "COLONIE_ACP_ENTRY",
  loginCommand: "codex login", askMode: "read-only", fullMode: "agent-full-access",
  // Codex's own modes, as the adapter advertises them: "Workspace access" and
  // "Auto review — only ask for actions detected as potentially unsafe".
  editsMode: "workspace-write", autoMode: "agent",
});
