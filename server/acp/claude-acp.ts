import { createAcpProvider } from "./acp-runtime.ts";
export const ClaudeAcpDriver = createAcpProvider({
  kind: "claude-acp", name: "Claude", version: "0.88.0",
  packageEntry: "@agentclientprotocol/claude-agent-acp/dist/index.js", entryEnvironment: "COLONIE_CLAUDE_ACP_ENTRY",
  loginCommand: "claude auth login", askMode: "default", fullMode: "bypassPermissions",
  // Claude's own modes, as the adapter advertises them: "Accept edits" and
  // "Auto — Claude handles permission decisions".
  editsMode: "acceptEdits", autoMode: "auto",
});
