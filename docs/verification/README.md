# Verifying Colonie

This is the active verification policy for the current macOS ACP application.
A recipe describes a method, not a claim that its last run passed. Select checks
for the changed boundary and report their actual result.

## Choose the smallest appropriate check

| Change | Appropriate starting evidence |
|---|---|
| Documentation only | Links, paths, and whitespace; no automatic build/runtime tests |
| ACP session, context, permissions, or connected tools | [ACP verification](colonie-acp.md), focused on the affected contract |
| Colonie memory | [Memory verification](colonie-memory.md) |
| UI interaction | Relevant isolated renderer check, followed by desktop evidence if the shell matters |
| Native-provider behavior | A separate bounded real-provider task after fixture evidence, with stated prerequisites and limits |
| Packaging/startup | A separately scoped artifact build and isolated launch on the advertised platform |

Run one heavy job at a time locally. Target test files rather than starting the
full suite after every change. Test-runner concurrency alone does not limit
browser, Electron, native adapter, or VM child processes. Bound the fixture's
duration/processes and stop its owned work if the budget is reached.

## Isolate every mutation

- Never verify writes against the user's live app, normal development server, installed workspace, or credential files.
- Allocate disposable application data, working files, ports, and renderer/Electron profiles. Use the fixture's printed URL/handle explicitly; do not discover a live port for mutations.
- For maintained ACP tests, use the repository's SDK fake agent and the `colonie` fixture option in `launchVerificationServer` from `scripts/control-colonie.ts`.
- Do not assume a generic legacy fake-engine recipe exercises the selected maintained adapter. Confirm the actual driver, session, and tool payload in evidence.
- Never inspect credential contents. Real-provider checks may inherit supported native authentication, use disposable workspaces, and have a bounded task. Do not copy/extract tokens or switch billing to make a check pass.

`pnpm colonie` and `pnpm colonie:web` are regular development launches using app
data. They are not disposable verification fixtures. Use the existing fixture
entry points described in the relevant recipe instead.

## Shared control surface

`scripts/control-colonie.ts` and `scripts/mcp-server.ts` provide shared control
operations. Their source and help define accepted commands. Pass the isolated
fixture URL explicitly to commands that inspect or mutate work; do not manufacture
a URL, bot ID, approval ID, or success result.

Foreground launchers must receive interruption directly so they can clean up
their children. Do not wrap one in a command that swallows Ctrl-C. Stop only the
process tree/temporary directory owned by the check; never kill by process name
or remove a broad temporary root.

## Evidence categories

Keep these distinct in [PROGRESS](../PROGRESS.md):

- **Static/unit:** source, schema, or local logic checks; not proof of a complete workflow.
- **Simulated provider:** real application boundaries with scripted agents/services; not real AI/tool execution.
- **Real provider:** exact bounded native-provider request, observed actions, and result; not automatically renderer/desktop evidence.
- **Renderer:** real UI interaction in an isolated browser; not automatically Electron packaging evidence.
- **Desktop/package:** actual shell/artifact with an isolated profile; does not establish provider success if the provider was simulated.

Record commands, outcome, action/result evidence, cleanup, remaining limitations,
and next step. Compilation alone is not workflow proof. An inherited failure,
timeout, quota error, or unavailable capability remains such; do not relabel it
as a pass. Redact evidence before saving it.

## Keeping these methods current

Only maintained ACP and memory methods remain here. Add a recipe when it has a
current owner, an isolated control path, and observable action/result evidence.
Do not copy a removed driver or hosting recipe back into this directory.

`scripts/testing/verification-docs.test.ts` checks document links, headings,
referenced source files, and package commands without launching the application.
A documentation check is not runtime workflow evidence.
