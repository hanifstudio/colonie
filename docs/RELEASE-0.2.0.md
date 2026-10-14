# Colonie 0.2.0 beta

Open Colonie in a browser at [https://172.104.33.55](https://172.104.33.55),
or [download the Apple silicon Mac app](https://172.104.33.55/downloads/Colonie-0.2.0-arm64.dmg).

Create an account and save the one-time recovery key somewhere private. There
is no email-confirmation step. If you lose your password, use the saved recovery
key on the sign-in screen; generating a replacement invalidates the old key.

Choose **Cloud** to work with other people. Create a workspace and your first
bot, then send a message. Colonie supplies Cloud AI access. Invite people from
**Members** by sharing an invitation link. Groups contain the people and bots
you add; DMs are private to their participants. Workspace owners do not gain
access to other people's DMs by default.

Choose **Local** in the Mac app for a private workspace on that Mac. Follow the
app's Claude or Codex sign-in instructions, name the first bot, then chat.
Use **Workspaces** to switch between Cloud and Local. Existing Local data can
be added explicitly from **Workspace → Add existing Local workspace**; it is
kept in place and assigned to the account that performed that action.
Opening or switching Local workspaces currently requires the Colonie account
service. An already open Local workspace remains available during a temporary
account-service outage; offline startup has not been implemented or verified.

Apps are optional. An owner/admin sets up that workspace's Composio project in
**Workspace settings → Apps**. People connect their own Gmail, Google Calendar
or Google Drive through the provider sign-in page. Personal app reads are
available in that person's bot DMs; deliberately shared app reads are available
to workspace bots in eligible conversations. Sending, editing and deleting
through Cloud app tools are not available in this beta. The deployed server
has no Composio organization key, so automatic project creation is unavailable
until the platform operator configures it. A read-only `session_management`
key cannot be used; failed validation keeps the previous key.

The Mac app is ad-hoc signed, without Apple notarization. If macOS blocks a
downloaded copy, open **System Settings → Privacy & Security → Open Anyway**.
This is not a Windows installer. Windows and phone users can use the browser.

Verification evidence and limits are in [PROGRESS.md](PROGRESS.md). Real Cloud
Claude text turns passed in disposable workspaces. Packaged Mac journeys used
deterministic AI fixtures; actual Composio OAuth/tool use, a real Local provider
turn on a recipient's Mac, a quarantined installation, and a physical phone
have not been verified. Existing VPS conversations have not been migrated to
the new account-based workspaces.
