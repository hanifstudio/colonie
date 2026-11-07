# Handover

## Now: follow up on a bot's answer as easily as in openbot

Three stages, each released alone. (1) Groups as dependable as 1:1 chats. Done: the 1:1 stall
watcher covers groups (the group's own sweep is gone), and its handler no longer crashes the
server (it called two removed Computer functions). Left: queued messages in a group visible and
cancellable; failure tests (restart, closed laptop, two bots). (2) Easier follow-up: reply to
one group message; a side question that does not interrupt the work; the bot's step list as a
card; reorder the queue. (3) Fewer repeats: several bots' answers arrive together; a "no reply
needed" mark; blocked reports with evidence; files a bot names attach themselves; quiet
routines; wait for the quota reset. Proof: a failure test on the fake engine, then a real
group. Out of scope: steering a running turn (ACP engines cannot), branching from an old message.

## Next: verify collaboration, browser panels, and conversation routines

Review group handoffs, Work, Browser, and Files with a person, in disposable
workspaces. Local Chromium cannot launch (macOS permission denied); real-engine
and real-window checks remain.

## After that: prepare the first public release

1. **The team code leaves the server.** Teams are gone from the app
   (owner, October 23). Left on the server: sections and their shared
   instructions, team memory, the section boundary between bots, a Chief
   per section, team routes, library, import and package code, and their
   tests. One Chief for the workspace, no boundary; prepared by the agent,
   committed by the owner (the hook keeps test deletions for the owner).
2. A lifetime license for Shared, bought once (owner decision).
3. Release: a signed, notarized `.dmg` (friends get an unsigned build from
   GitHub Releases, tag `friends-<version>`, so the legacy updater mirror
   skips it), the Colonie Cloud domain; the server image's last 600 MB
   (web-app-only packages, Next.js via better-auth).

Not yet seen: the installed app opening a `colonie://` link.
**Colonie Cloud is live** at https://colonie-cloud.hanifyaskur.workers.dev
(Neon through Hyperdrive `9cadf41e…`, schema `colonie_cloud`). After the
owner resets the Neon password: `wrangler hyperdrive update
9cadf41ef5894f3eafbf22df42ef749c --connection-string=…`. Before outside users:
a domain, per-IP limits, `/forgot` timing (Turnstile deferred).

## Before a public release

| What must be true | Status |
|---|---|
| CI passes on `main` | Release commit passes `pnpm check`, the Shared browser journey, and the selected desktop shell tests on GitHub |
| A version number and an update path | Server 0.3.23 is published. A raised package.json version on main publishes the image and Shared admins see Update |
| A Mac app built from this branch | Early-build 0.3.23 DMG and ZIP are published; isolated packaged startup passes on GitHub; clean-Mac installation untested |
| First run works in a real window | Isolated packaged startup checked; clean-Mac onboarding untested |
| Sign-in inside the app works with a real account | Never tried on a clean install |
| A bot answers through a real engine | Works in the owner's own data; never on a clean install |
| Creating and switching workspaces works by clicking | Tested in code only; never clicked |
| Conversations from the 0.2.0 build still work after upgrading | Not tested |
| The download is signed and notarized | Ad-hoc signed; Developer ID and notarization blocked by no Apple Developer account |
| The download page points to the new build | GitHub latest is `friends-0.3.23`; a public launch page is still needed |
| A bad release can be pulled back | Guard exists; recovery never rehearsed |
| A Shared workspace: one-click server, invite by link, people and bots together | Done and used on the owner's server; the Update button not yet used there |

## Known broken

- Release workflow needs `RELEASES_PAT`; `pnpm test:electron`, `pnpm i18n:check`, `pnpm clean`,
  `pnpm check:contrast` and `electron/fixtures/browser-closed-shadow.cjs` use deleted files.
- 72 failing test files were deleted October 18 (owner decision); no tests there.

## Not yet checked by a person

- No reset email has gone through Resend; the reset pages were never opened in a browser.
- Codex runs the project hook only after each person trusts it.
- The workspace switcher and the new welcome step have never been seen in a
  real window. The app's restart into another workspace has never been run.
- The owner's two stuck conversations, "Motion" and "Biscuit", should now
  rebuild their session. The next message sent in either one is the real check.
- A group's Files panel was never seen in a window, and no real engine has yet
  written into a group's project folder. A file a bot links in a group answer
  now opens from the project folder; never seen in a window.
- Logins kept between turns; non-admins and a bot's browser; the 950 MB Shared
  image on a droplet.

## Queue after the current task
0. Delete the non-ACP bot path (owner, November 3: ACP only), one file at a time (13 files
   behind `isColonieAcpDriver`).
0. Update a Shared workspace from the error screen (uncommitted in
   `AppErrorBoundary`); proved by a test only, not seen in a window.
1. Verify guides and groups with real engines: saving a guide from chat,
   the lead handing work on, and Ask when risky asking only for risky actions.
   Also: browser takeover by a signed-in bot and packaged app quitting.
2. A person installs Colonie on a clean Mac from a `.dmg` and completes the
   first run in a real window, with throwaway data.
3. Gaps in the engine connection, each needing a decision before code:
   - A message cannot be sent into a turn that is already running (no steering
     on the ACP engines).
   - Editing an earlier message (branching) does not work on ACP. Plan: open a
     fresh engine session for the branch and give it that branch's history.
   - Full tool results are never kept on ACP, so work summaries show previews only.
   - Old `native/<thread>.ndjson` readers remain; nothing writes those files. Decide which to keep.
4. Small fix: email sign-in answers 502 saying the accounts-service address
   "is set" when it is not set at all.
5. Remove the leftover brand word `maus`: first the unused `runOn` setting on
   routines and webhooks, then the mascot's CSS and component names.
6. Tidy the interface code into feature folders, one feature at a time.
