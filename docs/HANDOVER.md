# Handover

What is being worked on now, and what comes next. Rewrite this page as things
change; delete finished work. History is in Git.

Updated October 21, 2026.

## Now: a person installs Colonie from this code and completes the first run

The first step toward a public release. On a Mac that never had Colonie, a
person installs an app built from this branch, then: goes through the welcome,
signs in to an engine inside the app, gets an answer from a bot, creates and
switches a workspace, quits, and reopens.

- **Done:** the app builds again. Two build scripts missing from this branch
  were restored (`scripts/colonie/icons.ts`, `scripts/colonie/stage-runtime.mjs`).
  `pnpm colonie:package` produced
  `release/colonie/mac-arm64/Colonie.app`, which starts, serves the interface,
  creates a workspace with both engines, and quits cleanly.
- **Next:** build a `.dmg`
  (`pnpm colonie:dist`) and walk the journey in a real window, using a
  throwaway macOS user or a throwaway data folder, never the owner's
  `~/.colonie`. Note each step that fails, then fix them in order.
- **Proof:** the owner, or a recording, shows each step of the journey working.
- **Out of scope:** publishing, Server workspaces.

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

## Known broken

- `pnpm test:electron`: two tests (`mac-updater`, `vendor-updater`) import
  scripts that were deleted.
- `pnpm i18n:check`, `pnpm clean`, and `pnpm check:contrast` call deleted scripts.
- `package.json` still lists check commands whose scripts are gone
  (`colonie:ui-check`, `colonie:desktop-check`, `colonie:package-check`,
  `colonie:provider-check`).
- `electron/fixtures/browser-closed-shadow.cjs` requires a file that does not exist.
- 72 failing test files were deleted on October 18 by owner decision, so those
  areas have no tests now.

## Not yet checked by a person

- The workspace switcher and the new welcome step have never been seen in a
  real window. The app's restart into another workspace has never been run.
- The owner's two stuck conversations, "Motion" and "Biscuit", should now
  rebuild their session. The next message sent in either one is the real check.

## Queue after the current task

1. Fix CI so it runs what this branch actually has.
2. The rest of the release table above.
3. Gaps in the engine connection, each needing a decision before code:
   - The model list fills only when someone opens the model picker, so a bot
     created another way can only use the default model.
   - A message cannot be sent into a turn that is already running (no steering
     on the ACP engines).
   - Editing an earlier message (branching) does not work on ACP. Plan: open a
     fresh engine session for the branch and give it that branch's history.
   - Bots do not get the "this computer" tool on ACP; the code that built it
     only runs on the removed drivers.
   - Full tool results are never kept on ACP, so work summaries show previews only.
   - Old readers of `native/<thread>.ndjson` files remain, though nothing
     writes those files anymore. Decide which to keep.
4. Remove the leftover brand word `maus`: first the unused `runOn` setting on
   routines and webhooks, then the mascot's CSS and component names.
5. Tidy the interface code into feature folders, one feature at a time.
