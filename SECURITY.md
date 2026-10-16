# Security Policy

## Reporting a vulnerability

Do not open a public issue for a security problem. If GitHub private vulnerability
reporting is enabled for this repository, use it:
<https://github.com/hanifstudio/colonie/security/advisories/new>. Otherwise, use the
private channel already established with the repository owner.

Include the affected boundary, impact, and reproduction using disposable data.
Never include credentials, tokens, or private conversations in a public report.

## Scope

The currently supported application is a local **macOS** app. It can read files and run
tools with the permissions of the user running it; local execution is **not** a security
sandbox. Review the bind and authentication boundaries and the per-turn tool grants when
assessing a report.

Keep two kinds of approval distinct:

- Normal provider permission requests, authorized by the human operator, and
- Product-level confirmations.

Full access is a standing decision to approve provider permission requests. It must never
silently broaden unrelated credential, configuration, or approval operations.

This section describes the boundaries we want and the reports we care about. It is not a
certification that every gate currently passes.

## Protected data

Application data under `~/.colonie` can include credentials, configuration, and history.
Actual engine stores are owned by the provider and are app-isolated. Never read or publish
token contents. Logs and receipts must be redacted.

Do not assume that all secrets are held in plaintext or that all secrets are encrypted;
storage mechanisms differ.

## Research

Use disposable home directories and workspaces with isolated fixtures. Do not test
mutations against an installed user app. Confirm the real action and result, and follow
[`docs/verification/README.md`](docs/verification/README.md).

Source presence of gated hosted or team routes does not mean a hosted Colonie service is
supported today. Future server workspace security is described in
[`docs/COLONIE-BLUEPRINT.md`](docs/COLONIE-BLUEPRINT.md) and requires its own review. Do
not present a historical shared-service vulnerability as a deployed fact.

See [`AGENTS.md`](AGENTS.md) and [`docs/HANDOVER.md`](docs/HANDOVER.md) for the actual
current limitations.
