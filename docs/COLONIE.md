# Run Colonie

Colonie is the macOS personal-agent desktop fork of Colonie. It uses a
shared ACP runner with maintained Codex/Claude adapters and Bloub-based artwork.
The current core workflow and explicit scoped persona/SOUL context are implemented
for both providers. Context fixtures passed for both; real scoped-context evidence
is Claude-only while the latest real Codex quota blocker remains recorded.

## Open the built app

```sh
open "release/colonie/mac-arm64/Colonie.app"
```

The local build is macOS Apple Silicon and unsigned. App identity:
`com.colonie.desktop`. It includes pinned adapter/native runtime dependencies;
your global Codex/Claude installation is not replaced. Native provider login,
configuration and entitlement remain provider-owned.

Quit the old Colonie app before opening Colonie on the same fork data/profile;
the shared data-directory lease prevents concurrent writers.

If needed, use the official native login commands:

```sh
codex login
claude auth login
```

Choose the provider in the model picker **before the first message** of a new
thread. A native conversation remains with its provider; start a new thread to
change agents instead of silently showing old transcript with empty new context.
Models are discovered from the native session and checked before use. Refresh
Engines/model discovery after initial session setup to display the live catalog.

### Native controls

Click **Agent options** in the conversation header while the agent is idle. This panel
prepares or loads a session without sending a model prompt, then reads the model,
reasoning effort, model-config options and modes actually offered by the agent.
Explicit discovery also pins the session's folder; choose your working folder first.

- Model choices apply to this thread. Reasoning/model-config options and mode
  overrides are stored per thread/provider in `acp-settings/` under the app data.
- Native changes use a session/revision snapshot. If another tab/window changes
  the selection, refresh the panel before editing again.
- Changing models can change the available effort levels. Unsupported saved
  overrides are not guessed or silently downgraded: repair them in the panel,
  including **Apply displayed value**, before sending a message.
- Native mode overrides apply while the app's permission baseline stays the same.
  Changing Ask/Full reapplies its default mapping. Agent-reported fallback values
  become the effective values shown in the panel/receipt.
- **ACP context** records effective native options with the model/mode and
  application input on every turn. These controls do not add persona/SOUL context.

## Connected tools — Composio and Custom MCP

Click **Connected tools** beside the sidebar profile, or **Manage connections**
inside a bot profile. Colonie provides one built-in integration, **Composio**;
all other services use **Custom MCP** rather than vendor-specific presets.

### Composio

1. Add your Composio project key in app settings and click **Save key**. Packaged desktop uses the
   existing OS-encrypted credential store; source web mode uses the existing private
   server config. An explicit `COMPOSIO_API_KEY` runtime environment is also supported.
2. Search for an app and connect its account if required. Complete the external
   sign-in, then click **Refresh connections**. No-auth apps need no sign-in.
3. Open the bot profile → **Connected apps and tools**, select the Composio apps
   this bot should use, and click **Save tool access**.
4. Ask the bot to use those apps. Native permission requests still use Allow/Deny;
   Stop aborts outstanding Composio relay requests for that conversation.

Workspace connections are shared, but access is explicit per bot and defaults to
no app tools. The Composio session is scoped to its selected toolkits. Remote
workbench/bash helpers are not exposed by this initial integration. Credentials
stay in the application server; the agent receives only a local MCP bearer.
Account setup is manual in app settings; automatic continuation after OAuth is
not part of this slice. After connecting, send a follow-up to continue the task.

### Custom MCP

- Add a command/args/env server, a remote URL/headers server, or paste the
  `mcpServers` configuration you already use. Reuse the registry's Test and
  enable controls. Env/header values remain write-only in listings.
- Remote OAuth sign-in uses the existing registry flow when the server offers it.
  Complete sign-in in app settings before selecting it for a bot.
- In each bot profile, choose the Custom MCP entries it can use. Changes take
  effect on the next message and reload the same native session/history, rather
  than starting an empty conversation. Finish that bot's active conversations
  before changing its selection.
- Both pinned adapters support stdio and HTTP. Claude also supports SSE; Codex
  explicitly rejects SSE and reports how to choose a supported connection.
  Native/project MCP configuration remains provider-owned and is not rewritten.

ACP context remains opt-in Developer tools; receipts include non-secret mounted
server/toolkit metadata and Composio call statuses, never key/header values.

### Credential status and verification scope

Settings display the **Active key** as an identifying prefix/suffix with the
middle hidden, plus **Source** and **Origin**. A saved device credential may have
been entered in the app or imported from existing workspace settings; older
device records are labeled as having unavailable original setup history. An
environment-provided key has no Remove button because it is supplied outside the
app. Key availability is separate from Composio service readiness and each app's
Connected/Not connected status. Without a key the catalog and Connect controls
are hidden. Use **Replace key** or **Remove key** for editable sources.

Failed Save and Remove operations retain the old state and report the actual
failure reason. A failed IPC call is not automatically labeled a Keychain error.
Startup migration commits memory only after encrypted persistence succeeds.
Removing Composio keeps unrelated credential/identity fields; an actually empty
document can be removed without encrypting an empty payload. An unreadable
credential document is protected from replacement or deletion.

Both provider fixtures passed Composio/Custom HTTP/local command mounting,
scope denial, native Allow/Deny, Stop and reload/restart continuity. Packaged UI
fixtures additionally import/test/enable a local MCP server and choose access
through the normal bot profile. Real packaged Claude successfully performed a
bounded public Composio search/read and continued its native session after restart.

The earlier OS credential write **failed** with a temporary HOME that could not
access the macOS Keychain. Later synthetic probes succeeded on the same unsigned
Colonie artifact with OS Keychain access and isolated app data/profile. The targeted
packaged test now passes encrypted Save → full restart → Remove → full restart,
including imported-key origin and preservation of unrelated fields. No plaintext
fallback was added. This supersedes the earlier assumption that unsigned status
alone caused the failure; it does not guarantee every device/locked/corrupt store.
Historical failure: `.colonie-dev/evidence/composio-secure-store-blocker.json`.
Current proof: `.colonie-dev/evidence/credential-desktop-check.json` and
`credential-desktop-migration-check.json`. This follow-up uses no model turns or
real Composio/account requests.

## Existing Colonie data

Colonie preserves existing fork data in place:

| Data | Existing installation | Fresh installation |
| --- | --- | --- |
| App data | `~/.colonie-dev` when its `config.json` exists | `~/.colonie` |
| Electron profile | `~/Library/Application Support/Colonie` when present | `~/Library/Application Support/Colonie` |

Chats, input receipts and native session references keep their original paths.
This avoids moving absolute working directories that native sessions depend on.
The upgrade fixture proves continuity from the old Colonie bundled server/UI to
the new packaged Colonie app, using a disposable legacy home.
Original installed Colonie data is not imported or modified.

`COLONIE_DATA_DIR` and `COLONIE_USER_DATA` choose explicit locations.
`COLONIE_DATA_DIR` and `COLONIE_USER_DATA` remain compatibility aliases. The internal
`COLONIE_PROFILE` alias, protocol/HTTP contracts and `server/acp/` source paths
remain for compatibility; they are not a second product.

Existing Codex-only fork config automatically gains a Claude ACP instance in
the live fleet without overwriting the saved config or default provider. Native
histories and instance cursors remain distinct.

## Source launch

Use Node 24.13.1 or newer:

```sh
nvm use
pnpm install --frozen-lockfile
pnpm colonie
```

With Node 22 currently on your shell:

```sh
npm exec --yes --package=node@24.13.1 -- node scripts/colonie/start.ts
```

The launcher owns server/Vite/Electron children, chooses local ports, and stops
them on quit/Ctrl-C. `pnpm colonie:web` opens the same local execution surface for
browser development. Old `pnpm colonie` commands remain compatible.

## Core workflow and context

### Multiple conversations with one bot

Use **New conversation** above chat to start a separate job with the same bot.
**Conversations** lists its histories with titles, recent text previews and
Working / Needs approval / Unread status. Both controls are available in the
normal interface, including with the sidebar closed or the sidebar list hidden.
Expand a bot in the sidebar to browse its conversations there too.

- Each conversation keeps its own history, native session, working folder,
  options, permission requests and pinned profile. New conversations inherit the
  bot's saved profile and defaults; sibling histories are not sent to them.
- Switching does not stop other work. Return to a conversation to answer its
  permission request; **Stop** affects that conversation only. Background replies
  are marked unread. The bot row opens its last-selected conversation.
- Multiple jobs can run on one bot; the existing default limit is three active
  conversations per bot. The server queues work beyond its configured capacity.
  This slice verifies two simultaneous fixture sessions, not arbitrary provider
  throughput or cross-conversation memory.
- The sidebar display preference in Settings → Appearance works in both Simple
  and Advanced mode. It hides only the tree; chat navigation stays available.
  Folder creation stays Advanced-only. Existing folders and histories are retained.

### Core chat behavior

- Working folder is pinned on a thread's first turn. Choose a repository in the
  agent/project settings; start a new thread to change folders. Without one, the
  app creates a private task folder under the selected application data path.
- Chat streams incrementally and hydrates live output after renderer reconnect.
  Tool activity, Allow once/Deny, Stop and queued follow-ups are supported.
- Developers can enable **Developer tools** in Settings → General (Advanced mode)
  to access **ACP context** and inspect exact blocks saved before dispatch:
  cwd, effective model/mode, native session id, extra user context and result
  status. Newest 50 inputs per thread are retained, including attached images.
- Saved name/title/description and SOUL are used automatically in new conversations.
  Uploaded portraits and appearance remain presentation-only.
  Native project/system instructions remain agent-owned.
- If explicitly configured, `instances.<id>.config.instructions` is an extra
  user-context block recorded in every receipt. It is empty by default. Changes
  are pinned with the other stable context at first dispatch. Start a new thread
  to use updates or exclude earlier context from history.

### App-wide and bot-specific context

Colonie is designed for nontechnical users. Click the bot's name/avatar to edit
its profile: Name, Job, About this bot, and Instructions. The saved profile is used
automatically; there is no context-activation step. Add optional preferences for
every bot under Settings → General → **Instructions for all bots**.

The underlying scopes remain independent:

| Control | Scope | Source |
| --- | --- | --- |
| Colonie awareness/shared instructions | All bots in this workspace | Factory identity/capabilities and shared app instructions; enabled by default |
| This bot's persona | This bot only | Saved Name, Job/Title, About/Blurb and configured Chief identity; enabled by default |
| This bot's SOUL | This bot only | Saved Instructions/Soul; enabled by default |

Awareness/persona/SOUL default on whenever no explicit preference is saved.
Existing explicit developer preferences and conversation pins are preserved.
User-authored text retains its language; factory context is English (US).

**ACP context is a developer inspector**, off by default even in Advanced mode.
Enable Advanced mode in Settings → General, then turn on **Developer tools** on
that device. This reveals the chat inspector and the bot Overview's inspection
link. Its switches are for debugging/plain-native comparisons, not normal setup.
For a new plain/native conversation, explicitly turn off app/persona/SOUL additions
there and keep instance instructions empty. Do not disable the user's live context
as part of verification; use the isolated recipes below.

- Preview shows the saved context before sending. Native discovery opens a session
  without a prompt and does not pin context, so profile edits before the first
  dispatch still apply.
- Stable app, bot and instance context is pinned on first attempted prompt dispatch,
  after native setup succeeds, under `acp-context/threads/`. Settings live in
  `acp-context/app/` and `acp-context/bots/`. Existing threads keep their snapshot
  across follow-ups and app restart. The first turn captures its profile/settings
  when the message is admitted; edits during native setup affect later new
  conversations. Edit profiles/preferences, then start a new
  conversation to use the updates; the inspector shows a changed-profile notice.
- Conversations dispatched before this feature remain plain for app/bot additions.
  Turning on context never rewrites their native history.
- Effective capabilities/model/mode are regenerated at dispatch when app awareness
  is enabled. Permissions are enforced by runtime/native providers, not persona
  text. A Chief identity does not enable delegation.
- Each receipt includes scope, source, version, SHA-256, status and the exact input
  block mapping. Text blocks are ACP user content; they do not replace native system
  instructions. No legacy memory, recall, team, skills or automation context is added.
- A damaged/missing pinned snapshot refuses continuation instead of silently
  applying a different profile. Restore the saved snapshot or start a new conversation.

### Native permission differences

| Application selection | Codex ACP | Claude ACP |
| --- | --- | --- |
| Ask | `read-only`; exceeding it can request approval | `default`; manual native permissions |
| Full | `agent-full-access` | `bypassPermissions`, only if offered by the agent |

Other legacy approval selections currently use the Ask mapping. No app-owned
automatic reviewer is advertised. These native modes are not identical, and
the runner checks offered mode ids instead of emulating missing permissions.
The app's baseline selector offers Ask/Full for ACP. Other native choices such
as Plan/Accept edits/Auto appear only in the Native panel when offered by the
agent. The agent/model can clamp Auto; the panel shows the effective result
instead of promising an unavailable reviewer.

## Artwork

The pinned Bloub TypeScript engine powers React SVG avatars and generated
static icons. Colonie's default is a violet pebble; old saved shape/expression
ids have defined fallbacks, while uploaded avatars retain their image/crop path.
Reduced-motion/static views do not tick. Hidden/offscreen avatars pause their
animation; separate mask/gradient ids isolate concurrent SVGs.

Source/revision/license notes: `third_party/bloub/PROVENANCE.md` and `LICENSE`.
The maintained engine is kept separate from Colonie's React lifecycle and status
mapping. No Vue runtime is added. Regenerate icons with
`node scripts/colonie/icons.ts`; the package build does this before bundling.

## Checks and packaging

Run with Node 24. Browser tooling is installed under a gitignored checkout folder:

```sh
PLAYWRIGHT_BROWSERS_PATH="$PWD/.colonie-dev/browsers" pnpm exec playwright install chromium
pnpm typecheck
pnpm lint
pnpm colonie:test
pnpm colonie:ui-check
pnpm colonie:desktop-check
node scripts/colonie/ui-check.ts --claude --desktop
node scripts/colonie/ui-check.ts --native --desktop
node scripts/colonie/ui-check.ts --native --claude --desktop
node scripts/colonie/ui-check.ts --native --desktop --context
node scripts/colonie/ui-check.ts --native --claude --desktop --context
node scripts/colonie/ui-check.ts --desktop --native --profile
node scripts/colonie/ui-check.ts --claude --desktop --native --profile
node scripts/colonie/art-check.ts
pnpm colonie:package
pnpm colonie:package-check
node scripts/colonie/package-check.ts --claude
node scripts/colonie/package-check.ts --native --context
node scripts/colonie/package-check.ts --claude --native --context
node scripts/colonie/package-check.ts --native --profile
node scripts/colonie/package-check.ts --claude --native --profile
node scripts/colonie/package-check.ts --conversations
node scripts/colonie/package-check.ts --claude --conversations
node scripts/colonie/package-check.ts --connected-tools
node scripts/colonie/package-check.ts --claude --connected-tools
node scripts/colonie/connected-tools-web-check.ts
```

Explicit bounded native checks use inherited auth and disposable workspaces:

```sh
node scripts/colonie/provider-check.ts --real
node scripts/colonie/provider-check.ts --real --claude
node scripts/colonie/package-check.ts --real --tools
node scripts/colonie/package-check.ts --real --claude --tools
node scripts/colonie/package-check.ts --native
node scripts/colonie/package-check.ts --native --claude
node scripts/colonie/package-check.ts --real --native --claude --tools
node scripts/colonie/package-check.ts --real --claude --native --context
node scripts/colonie/package-check.ts --real --claude --native --profile
COMPOSIO_API_KEY="<project-key>" node scripts/colonie/composio-api-check.ts
COMPOSIO_API_KEY="<project-key>" node scripts/colonie/package-check.ts --real --claude --connected-tools
node scripts/colonie/native-controls-check.ts --real --claude
node scripts/colonie/package-check.ts --upgrade
```

`--tools` checks native Allow/Deny through the actual packaged UI and filesystem.
The offline `--upgrade` recipe requires the earlier Colonie artifact to be present;
it starts the old bundled server/UI and never uses the user's live app/data.
Commands leave receipts, logs and
screenshots under `.colonie-dev/evidence/`. Native session history remains provider-owned.

## Maintenance

Pinned versions: ACP SDK `1.7.0`; Codex adapter `2.1.1` with compatible CLI
`0.159.3`; Claude adapter `0.88.0` with Agent SDK/native dependency `0.3.293`.
Provider descriptors live in `server/acp/{codex-acp,claude-acp}.ts`; shared
transport/session logic is `acp-runtime.ts`. Do not fork native provider protocols.

Update packages deliberately, update descriptor/runtime manifest versions,
review upstream auth/session/mode changes, then run protocol/application/UI
fixtures, rebuild, and check the packaged app with bounded native requests.
ACP Registry is discovery/distribution; this app does not auto-download new
versions on boot. The upstream Colonie binary auto-updater stays disabled.

## Feature scope

Both providers support the current core flow and native model/effort/mode
controls where offered. Native history editing/rollback,
provider-to-provider history transfer, nested subagent UI, form elicitation,
detailed usage/limit accounting,
memory, Chief/team coordination, routines, computer/VM and voice are not claimed
as complete. Consult `PLAN.md` and `PROGRESS.md` for actual milestone status.
M7-A native controls are connected; real Claude and both provider fixtures passed.
The real Codex request for this slice was blocked by the account's usage limit
during verification; billing was not changed and the request was not retried.
Earlier Codex core evidence remains separate from this latest blocker.
M7-B explicit app/bot context is connected; both provider SDK/HTTP/desktop/package
fixtures and bounded packaged real Claude passed. This includes awareness,
persona/SOUL, preview/manifest, profile pinning and restart; it does not establish
Chief delegation or automatic memory.
The full upstream suite and every native agent feature are not implied by core
workflow verification. Office deployment is a separate milestone.

M8 connected tools are implemented for the named acceptance scope above. Arbitrary
MCP-server compatibility, all OAuth providers, real Codex connected-tool execution
and encrypted-store recovery on arbitrary devices/corrupt stores are not claimed
as passed. Synthetic packaged persistence on this machine passed as described above.

## Product language

Colonie targets primarily US users. App-authored UI, factory context, built-in
persona/SOUL templates, help and documentation use English (US). User-authored
content and native provider output retain their own language. The project owner's
working conversation with the coding assistant remains in Bahasa Indonesia.
