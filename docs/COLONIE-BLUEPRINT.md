# Colonie blueprint

Where Colonie is going and what the owner has decided. What is being built
right now is in [HANDOVER](HANDOVER.md).

## What Colonie is

Colonie is a desktop app where people work with AI bots. Each bot has a name,
a persona, skills, memory, and its own working files. Bots run on the person's
own Claude Code or Codex subscription. They can use connected apps, browse the
web, use a computer, and run on a schedule.

Work happens in a **workspace**. A workspace holds its bots, conversations,
connected apps, and engine sign-ins. There are two kinds:

- **Local**: runs on the person's own Mac. Personal: nobody can be invited.
  Free, no Colonie account.
- **Shared**: runs on a server the owner pays for, set up with one click from
  Colonie. The owner invites people, and people and bots work together. Bots
  run on the Claude or Codex subscription signed in on that server, through
  ACP. Not built yet.

The product reference is [Grok Bot](https://cursor.com/docs/grok-bot): when a
behavior is unclear, copy what Grok Bot does, then extend it where Colonie's
shared workspaces need more.

## What a person can do today

A local Mac app. A person can:

- go through the first-run welcome and get a first Local workspace;
- sign in to Claude or Codex inside the app, and add more named accounts;
- create bots with a name, persona, skills, and memory, and chat with them;
- connect apps (through their own Composio key) and custom MCP servers;
- run routines and webhooks, with three approval levels (Always ask, Ask when
  risky, Full access);
- create more Local workspaces and switch between them from the profile menu
  in the sidebar (the app restarts into the chosen workspace).

Much of this is checked only by tests and simulated engines, not yet by a
person clicking through a real install. HANDOVER says what is proven.

## What comes next, in order

1. **The first public release: Local and Shared workspaces.** A stranger
   installs Colonie, signs in, and a bot answers; an owner creates a Shared
   workspace in one click, invites people, and people and bots work together.
   Mac only at first, unless the owner decides otherwise. The steps are in
   "Plan: inviting people" below.
2. **A dependable working assistant.** Browser use, computer use, connected
   apps, approvals, and memory each proven with a real engine.
3. **Work that runs on its own.** Routines, webhooks, bots handing work to each
   other, Stop, and recovery after a restart, all working together without
   repeating a side effect (like sending an email twice).
4. **Later.** Mobile companion, voice conversation, bot email addresses.

## Plan: inviting people

Checked October 21. Nobody can be invited today. Inherited code from the
retired hosted product covers part of it: sign-in sessions with admin and
member roles, an allow-list of emails, recording who wrote a message and who
started a conversation, spend per person, and a desktop window that can point
at another server. What is missing:

- **Privacy.** Visibility is decided per bot, not per conversation. Two people
  using the same bot would see each other's chats live, and the bot's recall
  and memory could carry one person's chat into another person's answer. The
  owner and admins see everything, which conflicts with "nobody reads someone
  else's DMs."
- **A way in.** The emailed sign-in code went through the retired accounts
  service, the invite link points to a page that no longer exists, and there
  is no sign-in screen.
- **Reach.** The server only listens on its own computer, and the app has no
  screen to add or switch to another server.

Steps, in order. Each one is safe on its own:

1. **Private by person.** Every conversation knows its participants. A person
   sees only conversations they are in, and that holds for the owner and admins
   too; searching or quoting past messages never crosses into a conversation
   with different people. The bot's memory stays shared, by decision. Proven
   with two signed-in test people on a throwaway server, before anyone real
   can join.
2. **Colonie Accounts and invite by link.** A small Colonie-run account
   service (sign up, sign in, email and password). An admin creates a
   one-time invite link; opening it asks the person to sign in or sign up,
   then joins them to the workspace under their account.
3. **Run as a server.** A workspace runs on a server reachable over HTTPS, with
   its engines signed in there, not on anyone's Mac.
4. **Open it from the app.** The sidebar's Shared option connects to a
   workspace you were invited to.
5. **Group conversations** with people and bots, where a bot answers when named.
6. **One-click deployment.** Colonie sets up the server in the owner's own
   hosting account, shows the monthly cost first, and can remove it cleanly.

## Decisions

### Product and business

- The name is Colonie. It is independent of the project it was forked from.
- Keep the current desktop look and feel; the owner likes it.
- Local workspaces are free. A Shared workspace needs a lifetime license,
  bought once (owner decision, October 22), whether it runs on DigitalOcean
  or the owner's own server. Invited members pay nothing. Colonie does not
  host servers for now; a managed option may come after release. Still open:
  the price, per workspace or per account, and the payment provider.
- People bring their own keys for paid services (AI, Composio, speech, email).
  The one Colonie-run service is Colonie Accounts (below).
- **Colonie Accounts** (owner decisions, October 21 and 22): everyone signs
  up once for a Colonie account, email and password with reset by email, on
  first opening the app, Local included. One identity across every
  workspace. After that a Local workspace works offline and never checks
  the account again; a Shared workspace signs people in with it.
- **Colonie Cloud** is the one Colonie-run backend: Cloudflare Workers with a
  Neon Postgres database. Accounts are its first service; later Colonie
  services live there too. No domain yet; one is bought before release.
- Accounts, invitations, purchases, and updates are central Colonie services
  for Shared workspaces only. Bots, files, memory, credentials, and runs stay on
  the owner's own server.
- Each workspace's data lives on its own computer or server, owned and backed
  up by its owner. Deletion is real deletion. Logs are pruned after 180 days by
  default. A workspace is created Local or Shared and is never converted.

### Workspaces

- Two kinds, named Local and Shared in the app. Only a Shared workspace can
  invite people. The first public release has both.
- Colonie is where people and bots work together (owner, October 22). A
  workspace has three kinds of conversation, all in the sidebar: a DM with
  a bot (private to its people, who can add others), a DM between two
  people (a bot joins when @mentioned), and a group: a named room of
  several people and several bots. Only members see a conversation, admins
  included. For the first release: a group's lead bot answers what names no one;
  groups are by invitation; any member creates groups and adds any of the
  workspace's bots; a bot that needs permission asks the person who asked it.
  Later: bots working with each other in the open,
  open groups, pins, threaded replies.
- Every new Local workspace gets its own engine sign-in and connections. It
  never borrows another workspace's credentials or history.
- The first-run welcome flow stays as it is. One step was added: it explains
  workspaces, with Local selected and Shared shown but disabled ("Coming later").
- The workspace switcher lives in the sidebar's profile menu. Shared is shown
  there too, disabled, until it works. Never offer it as working.
- Switching workspaces restarts the app, and says so first, because unsent
  drafts are lost.
- Profile: a name is required and email is optional for Local; both are
  required for Shared. Email is never used to log in.

### Bots and engines

- Engines are Claude Code and Codex through the official ACP SDK and the
  maintained `@agentclientprotocol/*-acp` adapters. The old drivers are gone
  and stay gone.
- A named Claude or ChatGPT account is its own engine with its own sign-in folder.
- The app's sign-in is its own; a terminal that is already logged in does not count.
- If an engine has lost a saved conversation session, the app rebuilds it once
  from the conversation history and says so in the thread.
- Routines, webhooks, and hand-offs between bots run on the ACP engines. Edits
  and reruns that would rewind an engine's session are refused.
- Approval levels map straight onto each engine's own modes. If an engine
  lacks a level, the app falls back to Ask, never to more access.
- Three approval levels, the same in Simple and Advanced (owner, October 29):
  Always ask; Ask when risky, the default, where ordinary work (reading,
  writing project files, running commands, browsing) goes ahead and the
  engine's own reviewer asks only for risky actions; and Full access. The
  level belongs to the bot, so it acts the same in every group; a group shows
  each bot's level, and one action sets every bot in the group at once.
  Existing bots on Ask move to Ask when risky; Accept edits and Custom become
  Always ask, never more access.

### Routines

- A routine requested in chat belongs to that DM or group. People schedule,
  review, change, pause, resume, and run it there. The existing computer or
  group side panel lists each name and schedule; controls expand inline,
  and plus prepares a chat request. Status, approvals, and one report per
  run return to the conversation.
- One bot is responsible. It keeps its normal permissions, uses the
  conversation's project folder, and asks the person who requested the
  routine when approval is needed. Other conversations' routines stay private.
- In a Local workspace, Colonie must be open for routines to run. Interrupted
  work is reported clearly and is never blindly repeated after a restart.

### Browsers (owner, October 31)

- Each bot has its own browser and saved sign-ins. It opens when needed,
  and the person can watch, take over, and hand it back. A connected app
  comes first when it covers the task.
- Colonie does not provide desktop computer control, containers, remote
  desktops, or device control. There is no Computer setup or choice in
  Simple or Advanced mode. Existing desktop settings never start a desktop;
  browser access follows the bot's browser switch.
- Project files and the engine's normal file and command tools remain
  available. Browser-only Colonie does not remove those engine capabilities.
- Work files belong to the conversation, not the bot. A group has one
  project folder that every bot in it works in and every member sees; a DM
  has its own. Files stay when a bot leaves and go when the conversation is
  deleted. Grok Bot shares one unsorted computer; Colonie sorts by project.
- Access belongs to the bot, not to whoever is asking. An account given to a
  bot is the bot's, and it uses it for anyone it works with. Connecting an
  account to a bot in a Shared workspace says that everyone in the workspace
  can use it through that bot.
- Every bot in a Shared workspace is shared with all its members. No private
  bots and no hiding bots; personal accounts belong in a Local workspace.
- Browsing follows Grok Bot (owner, October 28). A connected app comes
  first; otherwise the bot picks between its engine's own web reading and its
  browser, with no rule or label for the person to learn. Proof is the bot's
  screen: its Browser panel opens from any conversation it works in, groups
  included. Opening, reading, and ordinary clicks run without asking;
  submitting a form, buying, and signing in wait for approval; passwords,
  codes, and CAPTCHAs are handed to the person.
- A person can step into a bot's browser, copying the open-source Grok Bot
  alternatives rather than inventing it (owner, October 28). A bot that hits
  a sign-in, CAPTCHA, or code it cannot do asks with a card, as OpenMausBot
  does; the person opens the browser, does that step, and presses Done, which
  resumes the bot. While the card waits, the browser stays in the person's
  hands. The panel opens by itself when a bot starts browsing and stays
  closed once the person closes it, as in Hermes.
- The pause and Done live on the server, so a future Telegram or Slack bot
  sends the same card with buttons and a link to the browser, as Hermes and
  OpenClaw do for approvals. The link needs the person signed in; forwarding
  it grants nothing.
- Grok Bot differs here on purpose: its computer and access belong to each
  person, and a bot has no identity of its own. In Colonie bots are members,
  like colleagues.

### Working together (for Shared workspaces)

- Members are people and bots. A group is visible only to its members; a direct
  conversation only to its participants. Nobody else reads it, including the
  owner and admins, and a bot never quotes or searches one conversation's
  messages inside another conversation with different people.
- A bot's memory belongs to the bot, not to each person: like a colleague, it
  remembers what it learned and can use it with anyone it works with.
- Bots in a Shared workspace run on the Claude or Codex subscription signed in
  on the server, through ACP (owner decision, October 21). Known risk, recorded
  so it is a choice and not a surprise: both providers' terms forbid letting
  other people use one person's subscription (Anthropic consumer terms and
  Claude Code legal page; OpenAI terms and Codex auth docs, checked October 21),
  so the owner's account could be limited or closed. The engines also accept an
  API key, which is the compliant fallback.
- The owner controls membership, workspace credentials, and risky approvals.
- To get a bot's attention, name it. Stop applies to the selected task and
  everything it handed off. Two tasks wanting the same bot's screen wait in line.
- A message in a group that names no one goes to the group's lead bot
  (owner, October 30, as OpenMausBot's rooms): the Chief of Staff when it is
  in the group, else the first bot added, or the bot the group chooses. The
  lead may hand parts to other bots by naming them, within the hop limit. A
  group can instead have every bot answer, or only bots that are named. A
  message that names a person, and no bot, wakes no bot.
- In a group, different bots work at the same time; one bot takes its own
  requests in order and says when a message waits for it (owner, October 29).
  What each busy bot is doing, and for how long, shows in place of dots.

### Removed on purpose

- Rooms and group chats in their old form. Old room files stay on disk and in
  backups but are not read. A read-only view of old rooms may come later.
- The Settings "Decision model" section. The code behind it stays for a future use.
- The old bot-to-bot delegation tools, phone pairing and the companion app,
  hosted and VPS setups, and the inherited brand.

## Code structure

```text
server/
  index.ts             Starts the server and wires the parts together
  runtime/             Workspace paths and what the workspace owns
  routes/              HTTP handlers
  colonie/<feature>/   Feature logic, with its tests
  acp/                 Talking to the Claude and Codex engines
  persistence/         Storage
src/                   The app's interface
shared/                Rules used by both server and interface
electron/              The desktop shell
scripts/               Build, launch, and checks
```

- Shared code never imports interface, server startup, or engine code.
  Features never import `server/index.ts`. The interface never touches storage
  or credentials directly.
- `pnpm structure:check` enforces these rules and the folder list in
  [the server map](structure/map.md).
- Reuse existing components and style tokens; do not build a second version
  of a control that already exists.

## Waiting on the owner

- Confirm with Anthropic that the Local app's in-app Claude sign-in is
  permitted: its Agent SDK docs say apps may not offer Claude login "unless
  previously approved", while its help center allows third-party apps.
- First release: Mac (Apple silicon) only, or more platforms?
- How this branch (`restructure`) reaches `main`. It is local only and must not be
  pushed until the owner says so.
- Version number for the first public release, and what people on the older
  0.2.0 build get.
- An Apple Developer account, so downloads open without a security warning.
- Whether to require CI to pass before changes reach `main` on GitHub.
- Deleting the old `colonie-vps` server from the Linode console (it is empty
  but still billed). Do not reconnect or redeploy it.

## One-click deployment: DigitalOcean first

Researched October 21 (docs.digitalocean.com); the owner agreed. It needs no
Colonie-run service:

- **Connect:** the app signs in to the owner's DigitalOcean account in the
  browser (OAuth for desktop apps, no secret), asking only for droplet,
  firewall, tag, and read permissions. Pasting a token is the fallback.
- **Create:** one Ubuntu droplet in Singapore with a firewall (ports 80 and
  443), set up on first boot by a small script that installs a pinned, checked
  Colonie server release. Everything is tagged so deleting is exact.
- **HTTPS without a domain:** Caddy with an automatic certificate on an
  `<ip>.sslip.io` name; the owner's own domain later.
- **Cost shown first:** 2 vCPU / 4 GB at $24 a month by default (live price from
  DigitalOcean), $48 for heavy browser use, weekly backups +20%. Billed by
  DigitalOcean to the owner, also while powered off; delete to stop.
- **Watch for:** new accounts may be limited in how many droplets they can
  make; mail ports are blocked; bots must not scrape or crawl in ways
  DigitalOcean's acceptable use policy forbids.

## Colonie Cloud: accounts design

Researched October 21 (developers.cloudflare.com, neon.com, resend.com):

- **How a person joins:** they open an invite link from a Shared workspace;
  it sends them to Colonie Cloud to sign in or sign up (email and password);
  Colonie Cloud sends them back with a one-time code; the workspace swaps the
  code for a signed proof of who they are and signs them in. The workspace
  never sees the password. (Standard sign-in-with flow: code plus PKCE.)
- **Stack:** one Cloudflare Worker (TypeScript) on Workers Paid, $5 a month,
  needed for safe password hashing time and for email to anyone; Neon Postgres
  (free plan) through Hyperdrive; `jose` for signed tokens (ES256), with a
  published public key that workspaces verify against.
- **Passwords:** scrypt (N=2^15, r=8, p=3), never PBKDF2 (Workers caps it far
  below safe strength). Generic errors and a lockout after ten failures.
  Turnstile is deferred (owner decision, October 21).
- **Invites are never emailed** (owner decision, October 21): the app shows the
  invite link with a copy button, and the admin sends it however they like.
- **Email:** password reset needs a domain we own to send to anyone. Until it
  is bought, reset emails reach only the owner's own address (for testing).
- **Address:** starts on a `*.workers.dev` address; the issuer address is a
  setting, because buying the domain changes it. Buy the domain before any
  outside beta.
- **The owner creates** the Cloudflare, Neon, and Resend accounts and holds
  every secret; engineering never reads them.

## Still to research

- Measure the default droplet size on a real browser-and-computer workload.
- How Grok Bot behaves where its documentation is silent (who replies in a
  group, what Stop cancels).
