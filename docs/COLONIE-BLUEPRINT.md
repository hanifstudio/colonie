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
  Colonie. The owner invites people, and people and bots work together; members
  use the workspace's bots without their own AI subscription. Not built yet.

The product reference is [Grok Bot](https://cursor.com/docs/grok-bot): when a
behavior is unclear, copy what Grok Bot does, then extend it where Colonie's
shared workspaces need more.

## What a person can do today

A local Mac app. A person can:

- go through the first-run welcome and get a first Local workspace;
- sign in to Claude or Codex inside the app, and add more named accounts;
- create bots with a name, persona, skills, and memory, and chat with them;
- connect apps (through their own Composio key) and custom MCP servers;
- run routines and webhooks, with four approval levels (Ask, Accept edits,
  Auto, Full access);
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
   too; recall, memory, and search never cross from one person's conversations
   into another's. Proven with two signed-in test people on a throwaway server,
   before anyone real can join.
2. **Invite by link.** The owner creates a one-time invite link; opening it
   signs that person in. No email service needed. Email codes can come later.
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
- Local workspaces are free. A Shared workspace is a one-time purchase per
  workspace; the price follows the server cost and is set after hosting is
  benchmarked. Invited members pay nothing.
- People bring their own keys for paid services (AI, Composio, speech, email).
  The first version runs no Colonie-paid service.
- Accounts, invitations, purchases, and updates are central Colonie services
  for Shared workspaces only. Bots, files, memory, credentials, and runs stay on
  the owner's own server.
- Each workspace's data lives on its own computer or server, owned and backed
  up by its owner. Deletion is real deletion. Logs are pruned after 180 days by
  default. A workspace is created Local or Shared and is never converted.

### Workspaces

- Two kinds, named Local and Shared in the app. Only a Shared workspace can
  invite people. The first public release has both.
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

### Working together (for Shared workspaces)

- Members are people and bots. A group is visible only to its members; a direct
  conversation only to its participants. Nobody else reads it, including the
  owner and admins.
- The owner controls membership, workspace credentials, and risky approvals.
- To get a bot's attention, name it. Stop applies to the selected task and
  everything it handed off. Bots wanting the same screen or browser wait in line.

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

- Which hosting provider the one-click deployment supports first.
- First release: Mac (Apple silicon) only, or more platforms?
- How this branch (`restructure`) reaches `main`. It is local only and must not be
  pushed until the owner says so.
- Version number for the first public release, and what people on the older
  0.2.0 build get.
- An Apple Developer account, so downloads open without a security warning.
- Whether to require CI to pass before changes reach `main` on GitHub.
- Deleting the old `colonie-vps` server from the Linode console (it is empty
  but still billed). Do not reconnect or redeploy it.

## Still to research

- **Blocks the release:** whether provider terms allow one owner's Claude or
  Codex subscription to serve invited members, and how engines sign in on a
  server without a browser.
- Which hosting setup to recommend, measured on a real browser-and-computer
  workload, with its cost.
- How Grok Bot behaves where its documentation is silent (who replies in a
  group, what Stop cancels, how a shared screen is shared).
