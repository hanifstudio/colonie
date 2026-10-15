# Complete original UI recovery

The owner reaffirmed on October 15 that the entire original Colonie interface
must return faithfully: layout, navigation, dialogs, controls and interactions.
Restoring a few familiar components is not completion. New account/workspace
features must fit that interface. Incremental delivery remains authorized;
the full restoration remains the goal across those increments.

The reference is the pre-multi-workspace Colonie fork at `744da8df`, with the
existing `Colonie-0.1.101-arm64` artifact available as a visual reference. This
is the ACP fork, not every upstream OpenMausBot feature that happens to remain
in the source tree. Reachability must be checked against the fork's actual
Simple, Advanced, developer-tool and ACP-driver conditions.

## Architecture and completion rules

- Use the original `App.tsx` shell and original components as the shared
  presentation foundation. Move Cloud account/workspace state behind explicit
  scoped ports; stop growing a second visual shell.
- Local retains its native store/runtime. Cloud must not mount the native
  StoreProvider or send unscoped legacy API requests. Its account/session,
  membership checks, private conversation audiences and generation guards
  remain authoritative.
- A missing new Cloud endpoint is a task to implement, not evidence that an
  original feature was intentionally retired. Disabled/hidden controls do not
  count as restoring formerly supported behavior.
- Preserve approved additions: per-workspace Local/Cloud choice, account
  signup/sign-in, invitations, bots as members, Groups and private human/bot
  DMs, workspace keys and personal app connections. Cloud members do not have
  to sign in to a native engine; Local keeps its native engine onboarding.
- For every original reachable surface, verify its entry action, rendered
  layout, interaction, resulting state and reload behavior in isolated
  fixtures. Keep renderer, desktop, simulated-provider and real-provider
  evidence separate. Compare against the reference at representative desktop
  and mobile sizes. Record exact commands and remaining gaps in PROGRESS.md.
- Do not call the recovery complete until the complete inventory is checked.
  Compilation, health checks, component reuse and worker reports alone are
  not completion evidence.

## Current milestones

| Area | Current evidence | Remaining work |
| --- | --- | --- |
| Bot identity, SOUL, avatar | Published from `892c508d`; isolated PostgreSQL, ACP dispatch fixture, Chromium and packaged Mac checks | Complete other original bot settings and creation surfaces |
| Original app settings | WIP reuses SettingsModal; 91 focused tests passed | Real renderer/desktop verification; all original reachable settings beyond the current Appearance slice |
| Shared original shell | DeepSeek implementation in progress | Integrate Cloud data controller; compare geometry, panels, chrome and navigation |
| Original global shortcuts | Extracted unchanged by DeepSeek; 13 focused hook tests passed | Mount through shared shell and verify actual Cloud keypress journeys |
| Transcript search and command palette | DeepSeek implementing scoped transport and authorization | Integrate original UI, older-message landing, privacy/reload/renderer verification |
| Exact baseline inventory | Two initial static audits completed; lead review found overcounts | Correct ACP/mode reachability, then finish the complete checklist |

The original Stop control remains present before ChatView's account-specific
header branch and routes through the Cloud interrupt dispatch. An initial
audit incorrectly called it unreachable; do not repeat that finding as fact.
Likewise, do not list every `App.tsx` mount as a missing ACP feature without
checking its actual gates. The complete corrected inventory follows after
that review; these milestones are not the full inventory.

## Full reference checklist

These rows are the recovery inventory, not completion claims. References are
to the original `744da8df` fork; the corrected DeepSeek gate report is retained
as source-audit evidence. Each row still needs action/result verification.

| Original area | Reference / reachability | Recovery requirement | Current state |
| --- | --- | --- | --- |
| Shared application frame | App.tsx shell; desktop/mobile, Simple/Advanced | Original panel columns, responsive sidebar collapse, drawer, scrim and caption chrome | Shared-shell refactor WIP |
| Local workspace entry | main.tsx / DesktopWorkspaceSwitcher | New workspace entry belongs in the original switcher; remove the added floating chip | Pending |
| Workspace/account additions | Original Sidebar switcher/footer slots | Preserve original presentation with account, invitation, People and human-DM additions | Partial |
| Roster and sidebar density/resize | Sidebar.tsx | All densities, resize persistence, selection/unread/attention states | Density renderer check pending |
| Sidebar transcript search | SearchResults.tsx, query length >= 2 | Original hits, highlight, correct conversation/message landing; private audience enforced | Scoped implementation WIP |
| Command palette | App.tsx / CommandPalette.tsx | Original Cmd/Ctrl+K, keyboard navigation, names and transcript hits | Shared-shell/search integration pending |
| Global keys and help | App.tsx / KeyboardShortcutsModal | Original new-bot/jump/previous-next/help keys and focus guards | Shared hook extracted; Cloud check pending |
| Bot context menus | Sidebar.tsx | Original rename/archive/delete/section/folder actions and confirmations, with member permissions | Pending |
| Archived bots and import | Sidebar create menu / ArchivedBotsPanel | Original recovery/import entry points and resulting state | Pending |
| Bot threads and folders | Sidebar / TaskPicker / NewThreadButton | Original conversations tree, create/switch/rename/delete/pin and persistence | Pending |
| Full bot creation | LocalNewBotDialog; baseline has the full editor | Original identity/SOUL/skills/memory/access/model/permissions creation interactions | Pending |
| Bot profile and Library | BotSettingsDialog / SimpleBotPanel | Original Details/Library and profile/appearance controls | Identity/SOUL/avatar published; Library/generation pending |
| Bot Skills | ColonieSkillsSection under ACP gate | Edit/save/use the bot's SKILL.md through scoped storage/runtime | Pending |
| Bot Memory and role controls | ColonieMemorySection / ChiefControls | Original shared/private scope UI and saved behavior with correct audience | Pending |
| Bot Access | BotConnectedTools under ACP gate | Original per-bot connections/grants UI, integrated with workspace/personal connections | Pending |
| Bot model and permissions | ACP section allow-list; permissions ask/full rules | Original model/native-settings and approval surfaces with actual capability/role enforcement | Pending |
| Chat header and conversations | ChatView ACP navigation/header | Original menu, model/options, new conversation, export/usage/activity/developer entry points | Partial |
| Composer | Composer / ComposerAttachments | Original attachment, mention, slash, queue, approval and supported voice/call controls | Plain-text replacement still present |
| Message interactions | ChatView / MessageActions | Original ACP-available reply/pin/copy/raw/speech/find/file interactions | Partial |
| Stop turn | ChatView before the account header branch | Actual visible Stop cancels the authorized turn | Present; new renderer cancellation check pending |
| In-conversation find | ChatFindBar | Original Cmd/Ctrl+F, results and highlight/landing | Pending |
| Group conversation | GroupView | Original group layout, member/folder/responder/pin/export and supported conversation controls, plus human members | Replacement conversation view still present |
| Application settings | ACP allows General/Appearance/Engines/Connections/Backups | Original rail/search/Simple/Advanced layout and all applicable controls | Appearance/General/connections shell WIP; remaining sections pending |
| Apps panel | SidebarAppsButton is reachable under ACP | Original Apps entry/panel and per-workspace/personal connection behavior | New connections UI only |
| Computer and file panels | ChatView computer entry / App panel mounts | Original configured/availability states and panel interactions in applicable mode | Cloud adaptation pending |
| Developer inspector/context | Advanced or opt-in developer gates | Original optional inspector/activity/context UI; never mandatory for bot setup | Cloud adaptation pending |
| Onboarding | Original WelcomeFlow plus approved new account flow | Preserve original presentation; Local native login, Cloud platform access, invited workspace entry | Account flow added; complete visual comparison pending |

Actual baseline exclusions must remain exclusions: the ACP footer hides
Routines/Triggers/Team map rows (`SidebarFooterNav.tsx:96`); ACP app settings
filter out unrelated upstream sections (`SettingsModal.tsx:791`); ACP bot
settings exclude routines/voice/history/usage/slack/visibility; native ACP
history already withholds message edit/regenerate/ArrowUp edit. Do not add
these back merely to inflate a parity list. Browser access is opt-in through
its actual capability/feature gates, not permanently retired. Computer, call
and developer controls require the applicable capability and configuration;
their actual baseline availability must be retained rather than invented.

## Delegation and limits

The owner explicitly requested lower-cost work through DeepSeek. Current
workers use `9router/alitp-intl/deepseek-v4.1-flash` through isolated OpenCode
processes, with bounded file ownership and no infrastructure credentials,
native authentication access, live application mutation or deployment access.
The Herdr skill was read, but the inherited pane identity did not resolve;
no other pane was altered. Worker reports are reviewed and independently
verified before integration/publication.

Real Cloud Claude replies remain authentication-blocked. Do not sign an
engine in or ask for credentials. The owner performs any reconnection; no
further paid provider check is authorized until that is done. This blocker
does not excuse the UI regression or mark its restoration complete.
