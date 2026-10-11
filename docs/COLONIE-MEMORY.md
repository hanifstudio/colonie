# Memory in Colonie

Colonie can carry useful details between a bot's conversations. Open a bot's
profile and look for **Memory** in Details. Full bot settings also have a Memory
section. Developer tools are not needed.

## What gets remembered

After a successful conversation, Colonie makes a separate, bounded request to
the bot's selected provider to identify durable facts, preferences and decisions
from your own message. This uses that provider's account and allowance. Failed or
stopped requests, other bots' messages and tool output are not capture sources.
Captured facts have a source quote and conversation date. A correction can update
an automatically remembered fact without waiting for a nightly cleanup.

- **About you · Shared with your bots** holds durable facts and preferences about
  you that other bots may use.
- **Only this bot** holds its project facts and decisions. Other bots do not get
  this private list or your other conversations automatically.

Memory and automatic capture start enabled. Saved off choices stay off. Workspace
controls affect all bots; controls under **This bot** affect only that bot. You
can keep recall enabled while turning automatic capture off.

## Review and control

- **Add a memory** explicitly saves a detail in the scope you choose.
- **Edit** changes a saved detail. Manual edits take precedence over automatic
  corrections; use the editor to revise a manually maintained detail again.
- **Forget** removes a detail from future retrieval. A suppression marker prevents
  automatic capture immediately restoring it. Explicitly adding it can restore it.
- **Clear** forgets a whole list.
- **Use memory** stops recall and capture for this bot but keeps its saved list
  available for review, editing and deletion.

If memory changes while you are editing, Colonie refuses the stale save and keeps
your draft. Refresh to review the current list before saving again. Turning
memory off, forgetting or editing invalidates older pending capture proposals.

Changes affect future retrieval. Text already sent to a model remains part of
that conversation's history. Start a new conversation for a fresh chat history.

## How it reaches the model

Relevant details are selected for each request and supplied as reference data,
separately from your message and the bot's profile/instructions. Memory does not
grant tool access or change permissions. At most 12 entries and 6,000 characters
are supplied; expired details are excluded. Retrieval uses a bounded preference
list and word overlap, not unlimited transcript search.

The application-owned ledger and capture queue live at
`<Colonie data directory>/colonie-memory/state.json`, using atomic owner-only
storage independently of native Claude/Codex sessions. The store allows up to
1,000 entries and a bounded queue; secret-shaped content is excluded. Legacy
Markdown notes are retained separately, without silently importing their old
context pipeline. Memory does not imply Chief delegation or scheduled routines.
