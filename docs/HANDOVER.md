# Handover

What is being worked on now, and what comes next. Rewrite this page as things
change; delete finished work. History is in Git.

Updated October 21, 2026.

## Now: a person sees only the conversations they are in

Step one of "Plan: inviting people" (blueprint). Local must behave exactly as
today. Steps, in order:

1. Done: a Shared workspace shows each person only threads naming them.
2. Done: conversations store their participants (server-private).
3. Done: own conversation per bot; every bot route acting on a thread uses
   the person's own and answers 404 for anyone else's.
4. Done: live updates and their replay, admins included.
5. Done: search scans only the person's own threads; workspace backups and
   team backups answer 403 to sessions; a bot's activity and the decision log
   list only the person's own threads.
6. **Current card.** Recall never quotes another conversation with different
   people; the bot's memory stays shared (owner decision). (Strong.)
7. Only a conversation's participants answer its approval cards. (Strong.)

Decided, reversible: routine and webhook threads belong to their creator; a
busy bot stays visible to all. Fix: the commit guard counts a final newline.
**Proof:** each step adds two-person checks (`server/testing/shared-workspace.ts`).

## Next: a person installs Colonie from this code and completes the first run

On a Mac that never had Colonie: install, welcome, engine sign-in, a bot
answers, create and switch a workspace, quit, reopen. The unpacked app builds
and boots (`pnpm colonie:package`). Next: a `.dmg` and the journey in a real
window with a throwaway user or data folder, never `~/.colonie`.

## Before a public release

| What must be true | Status |
|---|---|
| The release is built from code that reaches `main` | Waiting on the owner (see blueprint) |
| CI passes on that code | Broken: CI still calls scripts deleted from this branch |
| A version number and an update path for people on 0.2.0 | Not decided |
| A Mac app built from this branch | Built unpacked; no `.dmg`; never installed on a clean Mac |
| First run works in a real window | Never seen in a window |
| Sign-in inside the app works with a real account | Never tried on a clean install |
| A bot answers through a real engine | Works in the owner's own data; never on a clean install |
| Creating and switching workspaces works by clicking | Tested in code only; never clicked |
| Conversations from the 0.2.0 build still work after upgrading | Not tested |
| The download is signed and notarized | Blocked: no Apple Developer account |
| The download page points to the new build | Not started |
| A bad release can be pulled back | Guard exists; recovery never rehearsed |
| A Shared workspace: one-click server, invite by link, people and bots together | Not started; plan in the blueprint |

## Known broken

- `pnpm test:electron`: two tests (`mac-updater`, `vendor-updater`) import
  scripts that were deleted.
- `pnpm i18n:check`, `pnpm clean`, and `pnpm check:contrast` call deleted scripts.
- `electron/fixtures/browser-closed-shadow.cjs` requires a file that does not exist.
- 72 failing test files were deleted on October 18 by owner decision, so those
  areas have no tests now.

## Not yet checked by a person

- The OpenCode rules (`opencode.json`) load, but no live session has tried
  them: the DeepSeek model through 9router returned nothing on October 21,
  even for a one-word prompt, and the default model was out of quota.
- Codex asks each person to trust the project hook once (and after it
  changes) before it runs; until then only the Codex rules and sandbox apply.

- The workspace switcher and the new welcome step have never been seen in a
  real window. The app's restart into another workspace has never been run.
- The owner's two stuck conversations, "Motion" and "Biscuit", should now
  rebuild their session. The next message sent in either one is the real check.

## Queue after the current task

1. Fix CI so it runs what this branch actually has.
2. The rest of the release table above.
3. Gaps in the engine connection, each needing a decision before code:
   - A message cannot be sent into a turn that is already running (no steering
     on the ACP engines).
   - Editing an earlier message (branching) does not work on ACP. Plan: open a
     fresh engine session for the branch and give it that branch's history.
   - Bots do not get the "this computer" tool on ACP; the code that built it
     only runs on the removed drivers.
   - Full tool results are never kept on ACP, so work summaries show previews only.
   - Old readers of `native/<thread>.ndjson` files remain, though nothing
     writes those files anymore. Decide which to keep.
4. Small fix: email sign-in answers 502 saying the accounts-service address
   "is set" when it is not set at all.
5. Remove the leftover brand word `maus`: first the unused `runOn` setting on
   routines and webhooks, then the mascot's CSS and component names.
6. Tidy the interface code into feature folders, one feature at a time.
