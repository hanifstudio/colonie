# Connected tools in Colonie

Colonie's currently supported agent boundary is Claude and Codex through the
maintained ACP adapters. Connected apps and custom MCP servers are enabled and
selected with the ordinary controls in app and bot settings, so saving a bot
profile is normal setup and the ACP context inspector is not required.

A Composio project API key, supplied by you, provides access to Composio; each
service account must also be connected and authorized before its tools can do
anything. App configuration and connection selection decide which apps and
servers a given bot receives. A selection does not sign into an account, and it
does not start a server that is disabled.

Native agent tools and provider permission behavior stay provider-owned. The
app-supplied MCP selection is not a promise of universal native tool filtering
across adapters, and the retired `native:*` engine support matrix no longer
applies; it is historical only.

A selected local-command MCP server executes on the computer running the
runtime. A remote MCP server must be reachable from that same computer. The
current app runs locally, so this is the local machine; per-workspace
configuration belongs to the future target in the blueprint.

Changes are observed on subsequent work. If active work must finish or
reconnect first, follow the notice shown in the current UI. Do not assume that
external side effects are revoked dynamically; that behavior is not verified.

## References

- [`COLONIE-BLUEPRINT.md`](COLONIE-BLUEPRINT.md) — the target design
- [`verification/colonie-acp.md`](verification/colonie-acp.md) — how this is verified
- [`../server/colonie/connections/policy.ts`](../server/colonie/connections/policy.ts) — connection policy
- [`../server/colonie/connections/manager.ts`](../server/colonie/connections/manager.ts) — connection manager
