import { createAcpProvider } from "./acp-runtime.ts";
export { AcpRuntime as CodexAcpAdapter } from "./acp-runtime.ts";
export const CodexAcpDriver = createAcpProvider({
  kind: "codex-acp", name: "Codex", version: "2.1.1",
  packageEntry: "@agentclientprotocol/codex-acp", entryEnvironment: "COLONIE_ACP_ENTRY",
  loginCommand: "codex login", askMode: "read-only", fullMode: "agent-full-access",
  // Codex's own modes, as the adapter advertises them: "Workspace access" and
  // "Auto review — only ask for actions detected as potentially unsafe".
  editsMode: "workspace-write", autoMode: "agent",
  // `codex login --device-auth` through the adapter's bundled CLI, storing the
  // login as a file in this instance's CODEX_HOME (no OS keyring on a server).
  remoteSignIn: { kind: "device-code", args: ["cli", "-c", 'cli_auth_credentials_store="file"', "login", "--device-auth"] },
});
