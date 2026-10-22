// The server's front door: every HTTP request the app answers passes through
// here — static files, the route table, the desktop and connector channels. It
// was the largest block left inside `index.ts`. The wiring at the bottom of that
// file hands it the state it needs: as getters where a value is reassigned while
// the server runs (a plain pass would freeze the first value), and as setters
// where this module is the one that changes it.
import type { OwnThreads } from "../colonie/chat/own-threads.ts";
import type { ColonieSignIn, MemberRole } from "../colonie/accounts/colonie-signin.ts";
import { CALLBACK_PATH as DIGITALOCEAN_CALLBACK, type SharedServers } from "../colonie/deploy/shared-servers.ts";
import type { Caller, GroupConversations } from "../colonie/groups/group-conversations.ts";
import type { Secrets } from "../colonie/secrets/secrets.ts";
import { DESKTOP_CALLBACK, callbackPage, type DesktopAccount } from "../colonie/accounts/desktop-account.ts";
import { accountPhoto } from "../colonie/accounts/colonie-oauth.ts";
import type { ServerUpdate } from "../colonie/deploy/server-update.ts";
import * as composio from "../colonie/mcp/composio.ts";
import { ServerResponse } from "node:http";
import { IncomingMessage } from "node:http";
import { isColonieAcpDriver } from "../../shared/acp.ts";
import { approvalModeFor } from "../../shared/approval-mode.ts";
import { botAvatarUrlFromStoredPath } from "../../shared/bot-avatar.ts";
import { credentialIsConfigured, credentialResumeOutcome } from "../../shared/credential-request.ts";
import { loadBrand } from "../brand.ts";
import { avatarGenerationRequestSchema, avatarGenerationStateMatches, generateAvatarImage, snapshotAvatarGenerationState } from "../colonie/bots/avatar-image.ts";
import { memberBody, memberBot, notFoundFor, pathSubject } from "../colonie/bots/bot-visibility.ts";
import { botSkillTemplateSchema } from "../colonie/bots/new-bot-defaults.ts";
import { ATTACHMENTS_DIR, deleteAttachment, parseAudioRange, readAttachment, saveImage } from "../colonie/chat/attachments.ts";
import { listMessageFolder, messageAttachmentName, messageFileDisposition, messageFileDownloadName, messageFolderEntryName, messageImageTargetAt, messageReferencesFile, openMessageFile, openMessageFolderEntry } from "../colonie/chat/message-file.ts";
import { cancelSteeredMessage } from "../colonie/chat/steer-queue.ts";
import { titleConversationExcerpt } from "../colonie/chat/thread-title.ts";
import { browserEngineStatus, ensureChrome, installAgentBrowserBinary, resolveAgentBrowserBinary } from "../colonie/computer/browser-engine.ts";
import { SHARED_LOCAL_VM_TARGET, containerComputerAction, containerComputerExists, containerComputerScreenshot, containerComputerStatus, setupCommands } from "../colonie/computer/container-computer.ts";
import { localVmViewerStatus, viewerTargetId } from "../colonie/computer/desktop-viewer-targets.ts";
import { sharedComputerRegistration } from "../colonie/computer/shared-computers.ts";
import { MCP_OAUTH_CALLBACK_PATH } from "../colonie/mcp/mcp-oauth.ts";
import { fetchSkillFromSource } from "../colonie/skills/skill-fetch.ts";
import { installSkill, listBotSkillsWithOrigin, listStagedSkillWrites, parseSkillMd, removeSkill, setSkillEnabled } from "../colonie/skills/skills.ts";
import { isWorkspaceBackupSessionControl } from "../colonie/workspace/workspace-backup-http.ts";
import { DATA_DIR, builtInBrowserEnabled, llmThreadTitlesEnabled, localVmMaxInstances, localVmMode, saveConfig, sharedComputersEnabled, skillsLibraryEnabled } from "../config.ts";
import { assertRequestTarget, requestConflict } from "../guarded-requests.ts";
import { onJsonBody, json, readBody} from "../harness/http.ts";
import { searchMessagesAsync } from "../persistence/message-db.ts";
import { isProjectEmoji } from "../persistence/store.ts";
import { clearSessionCookie, isLoopbackHost, isProxied, labelFromUserAgent, parseCookies, requestOrigin, requestSource, resolveRequestAuth, serializeSessionCookie, type RequestAuth } from "../request-auth.ts";
import { pinnedClientThread } from "../routes/pinned-client.ts";
import { ROUTES, dispatchRoutes } from "../routes/table.ts";
import { environmentDescriptor } from "../runtime/environment.ts";
import { acceptedSendMatch, parseSendId } from "../send-idempotency.ts";
import { cookieMaxAgeSeconds } from "../sessions.ts";
import { assertWithinBudget } from "../spend.ts";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";

/** State and helpers the front door reaches; see the header for the getters. */
export interface RequestHandlerDeps {
  // ponytail: one permissive shape instead of ~200 hand-typed lines. The route
  // table is still checked where it is built; tighten this if the handler ever
  // gets its own tests.
  [name: string]: any;
  setBrowserEngineInstall: (value: any) => void,
  setBrowserEngineInstallError: (value: any) => void,
  setCustomDomainRevision: (value: any) => void,
  setLocalVmProvisionBusy: (value: any) => void,
}

export function createRequestHandler(deps: RequestHandlerDeps) {
  const {
    DEFAULT_PAGE, DESKTOP_MANAGED, ENVIRONMENT_ID, HOSTED_WORKSPACE, LOOPBACK, MAX_COMMS_DEPTH,
    PORT, SESSION_COOKIE, actorKey, beginAdminAudit, beginInternalCapabilityGeneration,
    botComputerControlKey, botComputerControlSnapshot, broadcast, browserEngineInstall,
    browserIntegration, browserLive, cancelDirectTurnDispatch,
    cardAnswerRefusal, cfg, checkedModelSelection, colonieChief, computerControl,
    computerPreviewBot, computerPreviewSurface, configStatus, connectedTools, connectorMessage,
    controlLeaseIdSchema, currentBrowserSession, currentSecretState, customDomainRevision,
    customDomainStatus, customDomainVerifier, deleteBotWithLifecycle, desktopMutationToken,
    desktopViewer, directRequestOwners, directTurnBots, directTurnDispatchClaims, emailSignIn,
    existingPerBotLocalVmCount, generateThreadTitle, guardedRequestSnapshot, handoffs,
    interruptAllDirectThreads, interruptDirectThread, lendingEnabled,
    listBotSkills, localVmActiveThreads, localVmFlags, localVmIdleFor, localVmIdleMs,
    localVmInventoryPayload, localVmLeaseFor, localVmLifecycleBusy, localVmOwnerBusy,
    localVmPayload, localVmProvisionBusy, localVmSeen, localVmTargetForBot, localVmTargetForStatus,
    maybeResumeConnectors, mcpOAuth, messageFileRootsForThread, messagePage, messageWindow,
    mintInternalCapability, pageSize, personKey, publicBot, publicBotQueuedMessages,
    readBotSkillFile, registry, requestedTaskBot, resolveReplyTarget, resumeSecretCard,
    revokeInternalCapabilitiesForThread, routines, secretMessage, serveStatic, 
    sessionLendingPrincipal, sessions, sharedComputerControl, sharedComputers,
    sharedWorkspaceFullAccessEnabled, stagedSkillListing, startTurn, store, subjectVisible,
    supportsApprovalMode, teamComputers, threadBusy, threadStarters, titleRegenerations,
    turnSelection, usageTriggerFor, viewerFor, visibleTo, wireBot, wireTask,
    workspaceAccess, workspaceBackupRoutes, workspaceMaintenance, setBrowserEngineInstall,
    setBrowserEngineInstallError, setLocalVmProvisionBusy,
    setCustomDomainRevision,
  } = deps;
  /** Each person's own conversations in a Shared workspace, and who the
   * caller is as a person (null in a Local workspace or for a non-person). */
  const ownThreads: OwnThreads = deps.ownThreads;
  const personOf: (auth: RequestAuth) => string | null = deps.personOf;
  /** Joining and signing in with a Colonie account (colonie/accounts/). */
  const colonieSignIn: ColonieSignIn | undefined = deps.colonieSignIn;
  const sharedServers: SharedServers | undefined = deps.sharedServers;
  const desktopAccount: DesktopAccount | undefined = deps.desktopAccount;
  /** Where people reach this server (COLONIE_PUBLIC_URL), else the request's own address. */
  /** This server itself, for a browser's way back from a sign-in elsewhere.
   * Never the page's own address: in development that is the UI server,
   * which forwards only /api here. */
  const ownOrigin = `http://127.0.0.1:${PORT}`;
  const publicUrlFor = (req: IncomingMessage): string => deps.publicUrl ?? `http://${req.headers.host ?? "127.0.0.1"}`;
const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
  let url: URL;
  try {
    url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  } catch {
    return json(res, 400, { error: "invalid request URL" });
  }
  const path = url.pathname;
  const method = req.method ?? "GET";
  /** scratch for route matches, shared by every `path.match` below */
  let m: RegExpMatchArray | null = null;
  let releaseWorkspaceRequest: (() => void) | undefined;
  try {
    // Hosted workspaces have one sign-in authority. A missing optional layer
    // must not accidentally reactivate legacy email/QR credential minting.
    if (HOSTED_WORKSPACE) {
      if (method === "POST" && ["/api/auth/email/start", "/api/auth/email/verify"].includes(path)) {
        return json(res, 403, { error: "Sign in through the workspace portal." });
      }
      if (workspaceAccess()) {
        if (await workspaceAccess().handlePublic(req, res, url)) return;
      } else if (path.startsWith("/api/auth/hosted/") || path === "/pair" || (path === "/" && (!isLoopbackHost(req.headers.host) || isProxied(req)))) {
        return json(res, 503, { error: "Workspace sign-in is unavailable." });
      }
    }
    // An MCP server's sign-in, started in a browser on another computer,
    // comes back here (server/mcp-oauth.ts). Public like the loopback
    // listener it stands in for: the state is the credential, checked once.
    if (path === MCP_OAUTH_CALLBACK_PATH) {
      const answer = method === "GET"
        ? await mcpOAuth.publicCallback(req.headers.host, url.search)
        : { status: 400, text: "Invalid sign-in callback. Return to Colonie and try again." };
      res.writeHead(answer.status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" });
      res.end(answer.text);
      return;
    }
    // ── who is asking (server/request-auth.ts) ──────────────────────────
    // Two public routes come first: what this server is.
    // Everything else needs the loopback owner or a session with the right scope.
    // Invite links and the way back from Colonie Cloud are public: the person
    // has no session yet. Each is a browser page, GET only, answered before
    // the web app's pages so their fallback page never swallows them.
    if (colonieSignIn && await colonieSignIn.handle(req, res, path, method, deps.publicUrl ?? null)) return;
    // The owner's browser coming back from DigitalOcean's sign-in. Public
    // like the MCP way back above: the state is the credential, used once.
    if (desktopAccount && method === "GET" && path === DESKTOP_CALLBACK) {
      const answer = await desktopAccount.callback(url.search);
      res.writeHead(answer.status, {
        "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      });
      res.end(callbackPage(answer.text, answer.status === 200));
      return;
    }
    if (sharedServers && method === "GET" && path === DIGITALOCEAN_CALLBACK) {
      const answer = await sharedServers.callback(url.search);
      res.writeHead(answer.status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" });
      res.end(answer.text);
      return;
    }
    if (method === "GET" && !path.startsWith("/api/") && !path.startsWith("/.well-known/") && serveStatic(res, path)) return;
    if (method === "GET" && path === "/.well-known/colonie/environment") {
      return json(res, 200, environmentDescriptor({ environmentId: ENVIRONMENT_ID, desktopManaged: DESKTOP_MANAGED, emailSignIn: !HOSTED_WORKSPACE && emailSignIn.enabled(), sharedComputers: lendingEnabled(), colonieSignIn: Boolean(colonieSignIn?.link()) }));
    }
    const domainCheck = /^\/\.well-known\/colonie\/domain-check\/([a-f0-9]{64})$/.exec(path);
    if (method === "GET" && domainCheck) {
      res.setHeader("cache-control", "no-store");
      const challenge = customDomainVerifier.challenge(domainCheck[1]);
      return json(res, challenge ? 200 : 404, challenge ?? { error: "No active domain check." });
    }
    // Sign in with an emailed code (server/account-signin.ts). Public like
    // /api/auth/pair, JSON-only for the same reason, and counted against the
    // same per-source lockout so a code cannot be guessed.
    if (method === "POST" && (path === "/api/auth/email/start" || path === "/api/auth/email/verify")) {
      if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) {
        return json(res, 415, { error: "send the sign-in request as JSON (content-type: application/json)" });
      }
      if (!emailSignIn.enabled()) return json(res, 404, { error: "email sign-in is not set up on this server" });
      const source = requestSource(req);
      const allowed = sessions.attemptAllowed(source);
      if (!allowed.ok) return json(res, 429, { error: `too many failed sign-in attempts from your address; try again in ${Math.ceil(allowed.retryAfterMs / 1000)}s` });
      const body = await readBody(req);
      const email = typeof body?.email === "string" ? body.email : "";
      if (path === "/api/auth/email/start") {
        const started = await emailSignIn.start(email);
        if (!started.ok) {
          if (started.status === 403) sessions.noteFailure(source);
          return json(res, started.status, { error: started.error });
        }
        return json(res, 200, { ok: true });
      }
      const code = typeof body?.code === "string" ? body.code : "";
      const label = typeof body?.label === "string" ? body.label : "";
      const verified = await emailSignIn.verify(email, code);
      if (!verified.ok) {
        if (verified.status === 401 || verified.status === 403) sessions.noteFailure(source);
        console.warn(`email sign-in refused from ${source}: ${verified.error}`);
        return json(res, verified.status, { error: verified.error });
      }
      sessions.clearFailures(source);
      const issued = sessions.issue({ label: label.trim() || labelFromUserAgent(req.headers["user-agent"]), scopes: verified.scopes, userId: verified.userId, email: verified.email });
      const environment = environmentDescriptor({ environmentId: ENVIRONMENT_ID, desktopManaged: DESKTOP_MANAGED, emailSignIn: true, sharedComputers: lendingEnabled() });
      const secure = requestOrigin(req)?.startsWith("https://") === true;
      res.setHeader("set-cookie", serializeSessionCookie(SESSION_COOKIE, issued.token, { secure, maxAgeSeconds: cookieMaxAgeSeconds(issued.session) }));
      return json(res, 200, { session: issued.session, environment });
    }
    const gate = resolveRequestAuth(req, {
      sessions,
      cookieName: SESSION_COOKIE,
      streamPath: "/api/events",
      url,
      loopbackMutationToken: desktopMutationToken(),
      features: { sharedComputers: lendingEnabled() },
      loopbackTrust: LOOPBACK.trust,
    });
    // The browser's cookie carries the term it was set with, and the
    // session's term slides on use (sessions.ts `renew`), so re-issue the
    // cookie on every cookie-authenticated request. One small header; and
    // unlike "send once per renewal" it survives a lost response and a
    // restart. Later handlers that clear the cookie (logout, self-revoke)
    // overwrite this header, which is the order we want.
    if (gate.auth?.kind === "session" && gate.auth.via === "cookie") {
      const presented = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
      if (presented) {
        const secure = HOSTED_WORKSPACE || requestOrigin(req)?.startsWith("https://") === true;
        res.setHeader("set-cookie", serializeSessionCookie(SESSION_COOKIE, presented, { secure, maxAgeSeconds: cookieMaxAgeSeconds(gate.auth.session) }));
      }
    }
    // Reachability probe, public: the phone races it across a server's
    // addresses before it has a session, and the tunnel verifier polls it.
    // A stranger learns only the app name; pid (the desktop boot probe keys
    // on it) and the static flag stay behind the gate below.
    if (method === "GET" && path === "/api/health" && !gate.auth) {
      return json(res, 200, { app: "colonie" });
    }
    // The brand is public too: the sign-in page must carry the deployment's
    // name and icon before anyone has a session, and it holds nothing secret.
    if (method === "GET" && path === "/api/brand" && !gate.auth) {
      return json(res, 200, loadBrand());
    }
    if (!gate.auth) return json(res, gate.status, { error: gate.error });
    const auth = gate.auth;
    if (HOSTED_WORKSPACE && auth.kind === "session") {
      const failure = workspaceAccess()
        ? await workspaceAccess().authorize(req, auth)
        : { status: 503, error: "Workspace sign-in is unavailable." };
      if (failure) return json(res, failure.status, { error: failure.error });
    }
    // Bot visibility: a member reaches a restricted bot, its threads, rooms,
    // routines and files exactly as they reach an id that does not exist.
    // Lists and live frames are narrowed where they are built, below.
    const visible = visibleTo(viewerFor(auth));
    if (!visible.everything) {
      const subject = pathSubject(path);
      if (subject && !subjectVisible(subject, visible)) return json(res, 404, { error: notFoundFor(subject) });
      // A bot route can name one of the bot's threads in its path or query; a
      // person reaches only their own (bot-visibility.ts).
      const namedThread = /^\/api\/bots\/[\w-]+\/tasks\/([\w-]+)/.exec(path)?.[1] ?? url.searchParams.get("threadId");
      if (visible.personal && namedThread && !visible.thread(namedThread)) return json(res, 404, { error: "no such task" });
      // Every bot a member is sent (a read receipt, a profile or display
      // edit, a new or switched task) comes without its audience list or
      // the teammates they cannot see, whichever route answers.
      onJsonBody(res, (body) => memberBody(body, visible));
    }
    beginAdminAudit(req, res, method, path, auth);

    if (method === "POST" && path === "/api/workspace-backup/restore" && teamComputers.list().some((computer: any) => computer.section !== null)) {
      return json(res, 409, { error: "Unassign team computers before restoring a workspace; restored team names must not gain access to existing desktops" });
    }
    if (await workspaceBackupRoutes(req, res, path, auth)) return;
    // Count ordinary requests until their asynchronous handler returns, not
    // merely until the browser disconnects. A cancelled upload can still write.
    if (path.startsWith("/api/") && path !== "/api/events" && path !== "/api/health" && !path.startsWith("/api/shared-computers/") && !isWorkspaceBackupSessionControl(method, path)) {
      releaseWorkspaceRequest = workspaceMaintenance.request();
    }

    // New routes live in modules registered in server/routes/table.ts and
    // are tried here, behind the gate above; do not add route `if`s below.
    if (await dispatchRoutes(ROUTES, { req, res, url, path, method, auth, json, readBody })) return;

    // ── sessions: who am I, tickets, pairing and revocation ─────────────
    // Who is signed in, the same in every kind of workspace: the Colonie
    // account of this computer's owner, or of the person a session is for.
    if (method === "GET" && path === "/api/me") {
      if (auth.kind === "loopback") return json(res, 200, { account: desktopAccount?.account() ?? null });
      const email = auth.session.email?.trim().toLowerCase();
      if (!email) return json(res, 200, { account: null });
      const member = colonieSignIn?.members().find((entry) => entry.email.toLowerCase() === email);
      const issuer = colonieSignIn?.link()?.issuer;
      return json(res, 200, { account: { name: member?.name || email, email, ...(issuer && member?.sub ? accountPhoto(issuer, member.sub) : {}) } });
    }
    if (method === "GET" && path === "/api/auth/session") {
      return json(
        res,
        200,
        auth.kind === "loopback"
          ? { kind: "loopback", scopes: auth.scopes, environmentId: ENVIRONMENT_ID, ...(auth.trust ? { trust: auth.trust } : {}) }
          : {
              kind: "session",
              id: auth.session.id,
              label: auth.session.label,
              scopes: auth.scopes,
              expiresAt: auth.session.expiresAt,
              via: auth.via,
              environmentId: ENVIRONMENT_ID,
              // the account behind the session, when it came from a sign-in
              ...(auth.session.email ? { email: auth.session.email } : {}),
              // whose COLONIE Cloud a browser sign-in signed in to
              ...(auth.session.owner ? { owner: auth.session.owner } : {}),
              // a hosted team workspace or a Shared one: the web UI's first
              // run skips the beats about this computer there (and a member
              // gets a note instead). Absent everywhere else.
              ...(HOSTED_WORKSPACE || ownThreads.shared() ? { hosted: true } : {}),
            },
      );
    }
    if (method === "POST" && path === "/api/auth/stream-ticket") {
      if (auth.kind === "loopback") return json(res, 200, { ticket: null, reason: "loopback needs no ticket" });
      return json(res, 200, sessions.issueStreamTicket(auth.session.id));
    }
    if (method === "POST" && path === "/api/auth/logout") {
      if (auth.kind === "session") sessions.revoke(auth.session.id);
      res.setHeader("set-cookie", clearSessionCookie(SESSION_COOKIE));
      return json(res, 200, { ok: true });
    }
    // Admin-only via request-auth's default deny. Connecting a domain only
    // changes future pairing links; DNS, proxy setup, webhooks and all existing
    // sessions remain untouched. The tunnel/deployment URL is kept as fallback.
    if (path === "/api/settings/custom-domain") {
      res.setHeader("cache-control", "no-store");
      if (method === "GET") return json(res, 200, customDomainStatus());
      if (method === "POST" || method === "DELETE") {
        if (DESKTOP_MANAGED) return json(res, 409, { error: "Custom domains are configured on a self-hosted Colonie server, not the desktop companion." });
        if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) {
          return json(res, 415, { error: "content-type must be application/json" });
        }
        if (method === "DELETE") {
          saveConfig({ customDomain: "" });
          cfg.customDomain = "";
          setCustomDomainRevision(customDomainRevision() + 1);
          return json(res, 200, customDomainStatus());
        }
        const body = await readBody(req, 4096);
        if (typeof body?.domain !== "string") return json(res, 400, { error: "Enter your domain name." });
        const revision = customDomainRevision();
        const verified = await customDomainVerifier.verify(body.domain);
        if (auth.kind === "session" && !sessions.isLive(auth.session.id)) {
          return json(res, 401, { error: "Your session ended. Sign in again before connecting a domain." });
        }
        if (revision !== customDomainRevision()) return json(res, 409, { error: "Domain settings changed during verification. Try again." });
        saveConfig({ customDomain: verified.origin });
        cfg.customDomain = verified.origin;
        setCustomDomainRevision(customDomainRevision() + 1);
        return json(res, 200, customDomainStatus());
      }
    }
    // The desktop's own server always answers its desktop here: lending to the
    // person's Cloud (docs/cloud-pro.md) needs the lease without the
    // maintainer flag. It grants nothing by itself; it only keeps local bot
    // turns and a remote screen action from using the screen at once.
    if (method === "POST" && path === "/api/desktop/shared-computer-control" && (sharedComputersEnabled(cfg) || DESKTOP_MANAGED)) {
      if (auth.kind !== "loopback") return json(res, 403, { error: "Local desktop only" });
      const body = await readBody(req, 1024);
      if (!sharedComputersEnabled(cfg) && !DESKTOP_MANAGED) return json(res, 404, { error: `no route: ${method} ${path}` });
      if (!z.string().uuid().safeParse(body?.id).success || !["acquire", "release", "renew"].includes(body?.action)) return json(res, 400, { error: "Invalid computer lease" });
      if (body.action === "release") sharedComputerControl.release(body.id);
      else if (body.action === "renew") sharedComputerControl.renew(body.id);
      else {
        sharedComputerControl.acquire(body.id);
      }
      return json(res, 200, { ok: true });
    }
    // A paired desktop registers only its own outbound connector. A second,
    // main-process-only secret binds poll/results to that exact desktop.
    // With features.sharedComputers off the whole family falls through to the
    // generic "no route" 404, so a probe cannot tell a disabled feature from
    // a build that never had one.
    // What the asking person has lent to this server, online or not, with its
    // scopes (docs/cloud-pro.md, "What the Cloud can see"). Owner-scoped like
    // the bot routes; no id a session could not already use, and no secret.
    if (method === "GET" && path === "/api/shared-computers" && lendingEnabled()) {
      return json(res, 200, { computers: sharedComputers.status(sessionLendingPrincipal(auth)) });
    }
    if (method === "POST" && path.startsWith("/api/shared-computers/") && lendingEnabled()) {
      if (auth.kind !== "session") return json(res, 403, { error: "Pair this desktop first" });
      if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) return json(res, 415, { error: "JSON required" });
      const body = await readBody(req, 4_000_000);
      if (!lendingEnabled()) return json(res, 404, { error: `no route: ${method} ${path}` });
      if (!sessions.isLive(auth.session.id)) return json(res, 401, { error: "Session ended" });
      const secret = String(req.headers["x-colonie-computer-secret"] ?? "");
      if (path === "/api/shared-computers/connect") {
        const parsed = sharedComputerRegistration.safeParse(body);
        if (!parsed.success) return json(res, 400, { error: "Invalid computer registration" });
        const registration = parsed.data;
        if (registration.environmentId !== ENVIRONMENT_ID) return json(res, 409, { error: "Workspace identity changed. Pair again before sharing this computer." });
        // A Cloud home is one person's: only their own devices, which the
        // Admin's pairing signs in with admin scope, may lend to it.
        sharedComputers.register(registration, { session: auth.session.id, person: personKey(auth.session) }, secret);
        return json(res, 200, { ok: true });
      }
      const route = /^\/api\/shared-computers\/([\w-]+)\/(poll|lease|result|disconnect)$/.exec(path);
      if (!route) return json(res, 404, { error: "not found" });
      const [, id, action] = route;
      if (action === "poll") return json(res, 200, { job: await sharedComputers.poll(id, auth.session.id, secret) });
      if (action === "lease") return json(res, 200, { active: sharedComputers.liveJob(id, auth.session.id, secret, String(body?.jobId)) });
      if (action === "result") sharedComputers.complete(id, auth.session.id, secret, String(body?.jobId), body?.result);
      if (action === "disconnect") sharedComputers.disconnect(id, auth.session.id, secret);
      return json(res, 200, { ok: true });
    }
    // Isolated integration fixtures cannot invoke an MCP tool before their
    // fake provider exits, so they mint an exact synthetic turn capability
    // through a per-process high-entropy test key. The route does not exist
    // unless the launcher explicitly sets that key; production builds never
    // set it.
    if (method === "POST" && path === "/api/testing/internal-capability") {
      const expected = process.env.COLONIE_TEST_INTERNAL_CAPABILITY_KEY ?? "";
      const actual = Array.isArray(req.headers["x-colonie-test-capability"])
        ? ""
        : String(req.headers["x-colonie-test-capability"] ?? "");
      const expectedBytes = Buffer.from(expected);
      const actualBytes = Buffer.from(actual);
      if (
        !expected ||
        actualBytes.length !== expectedBytes.length ||
        !timingSafeEqual(actualBytes, expectedBytes)
      ) return json(res, 404, { error: "not found" });
      const parsed = z.object({
        botId: z.string().regex(/^[\w-]{1,128}$/),
        threadId: z.string().regex(/^[\w-]{1,128}$/),
        kind: z.enum(["agents", "connectors", "computer"]).default("agents"),
        depth: z.number().int().min(0).max(MAX_COMMS_DEPTH).default(0),
        skillAuthoring: z.boolean().default(false),
      }).strict().safeParse(await readBody(req));
      if (!parsed.success || !store.bot(parsed.data.botId)) {
        return json(res, 400, { error: "invalid test capability" });
      }
      const generation = beginInternalCapabilityGeneration(parsed.data.threadId);
      const token = mintInternalCapability({
        ...parsed.data,
        generation,
        createdBots: 0,
        openedThreads: 0,
      });
      return json(res, 201, { token });
    }
    if (path === "/api/internal/colonie-mcp") {
      return await connectedTools.handle(req, res, method === "POST" ? await readBody(req) : null);
    }
    if (path === "/api/internal/colonie-workspace-mcp") {
      return await colonieChief.handle(req, res, method === "POST" ? await readBody(req) : null);
    }

    // ── events stream ──
    // Owner-only (default-deny in request-auth). Never mix login frames into
    // the general events feed, which is also visible to client-only devices.
    const liveBrowserMatch = /^\/api\/bots\/([\w-]+)\/browser\/(live|action)$/.exec(path);
    if (liveBrowserMatch) {
      res.setHeader("cache-control", "no-store");
      const bot = store.bot(liveBrowserMatch[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (!builtInBrowserEnabled(cfg) || bot.browser === false) {
        return json(res, 409, { error: "Enable this bot's browser in its profile first." });
      }
      const browser = await browserIntegration(bot.id, bot.browserProfile);
      if (!browser) return json(res, 503, { error: "Install the browser engine first." });
      // Browser discovery may have awaited while the portal became unavailable
      // and closed this owner's streams. Do not open a late replacement on
      // the earlier authorization; once registered, exact-owner close covers it.
      if (HOSTED_WORKSPACE && auth.kind === "session") {
        const failure = workspaceAccess()
          ? await workspaceAccess().authorize(req, auth)
          : { status: 503, error: "Workspace sign-in is unavailable." };
        if (failure) return json(res, failure.status, { error: failure.error });
      }
      const owner = auth.kind === "session" ? auth.session.id : "local-owner";
      const isCurrent = () => {
        const current = store.bot(bot.id);
        return !!current && current.browser !== false && builtInBrowserEnabled(cfg)
          && currentBrowserSession(current.id, current.browserProfile) === browser.session
          && (auth.kind !== "session" || sessions.isLive(auth.session.id));
      };
      if (method === "GET" && liveBrowserMatch[2] === "live") {
        req.socket.setTimeout(0);
        return await browserLive.open({ botId: bot.id, session: browser.session, spec: browser.spec, owner, isCurrent, res });
      }
      if (method === "POST" && liveBrowserMatch[2] === "action") {
        const body = await readBody(req, 32_768);
        if (!isCurrent()) return json(res, 409, { error: "This browser session changed. Reopen the browser panel." });
        if (typeof body?.viewerId !== "string") return json(res, 400, { error: "A live browser connection is required." });
        if (body.type === "restart" && store.bots.some((candidate: any) => candidate.busy &&
            currentBrowserSession(candidate.id, candidate.browserProfile) === browser.session)) {
          return json(res, 409, { error: "Stop every bot using this profile before restarting its browser." });
        }
        return json(res, 200, await browserLive.action({ viewerId: body.viewerId, botId: bot.id, owner, body }));
      }
      return json(res, 405, { error: "method not allowed" });
    }

    // ── Colonie accounts: connect this workspace, invite people (admins) ──
    // Admin scope by default (request-auth.ts lists no client access here).
    if (colonieSignIn && method === "GET" && path === "/api/colonie-cloud") {
      return json(res, 200, { link: colonieSignIn.link(), members: colonieSignIn.members().map(({ email, name, role, joinedAt }) => ({ email, name, role, joinedAt })) });
    }
    if (colonieSignIn && method === "POST" && path === "/api/colonie-cloud/connect") {
      const body = await readBody(req);
      const issuer = typeof body?.issuer === "string" ? body.issuer.trim() : "";
      const name = typeof body?.name === "string" && body.name.trim() ? body.name.trim() : "Colonie workspace";
      if (!/^https?:\/\/\S+$/.test(issuer)) return json(res, 400, { error: "issuer must be the Colonie Cloud address" });
      try {
        return json(res, 200, { link: await colonieSignIn.connect(issuer, name, publicUrlFor(req)) });
      } catch (error) {
        return json(res, (error as { status?: number }).status ?? 502, { error: (error as Error).message });
      }
    }
    if (colonieSignIn && method === "DELETE" && (m = path.match(/^\/api\/colonie-cloud\/members\/([^/]+)$/))) {
      const email = decodeURIComponent(m[1]).trim().toLowerCase();
      const admins = (cfg.signIn?.admins ?? []).map((entry: string) => entry.trim().toLowerCase());
      if (admins.includes(email) && admins.filter((entry: string) => entry !== email && !entry.startsWith("@")).length === 0) {
        return json(res, 409, { error: "This is the last admin. Make someone else an admin first." });
      }
      if (!colonieSignIn.removeMember(email) && !admins.includes(email) && !(cfg.signIn?.members ?? []).some((entry: string) => entry.trim().toLowerCase() === email)) {
        return json(res, 404, { error: "No such person in this workspace." });
      }
      return json(res, 200, { ok: true });
    }
    if (colonieSignIn && method === "POST" && path === "/api/invites") {
      if (!colonieSignIn.link()) return json(res, 409, { error: "connect this workspace to Colonie accounts first" });
      const body = await readBody(req);
      const role: MemberRole = body?.role === "admin" ? "admin" : "member";
      return json(res, 201, colonieSignIn.createInvite(role, publicUrlFor(req)));
    }

    // ── updating this Shared workspace's server (admins; colonie/deploy/server-update.ts) ──
    if (path === "/api/server-update") {
      const serverUpdate: ServerUpdate | undefined = deps.serverUpdate;
      if (!serverUpdate) return json(res, 404, { error: "This server is not updated from the app." });
      try {
        if (method === "GET") return json(res, 200, await serverUpdate.status());
        if (method === "POST") {
          const status = await serverUpdate.status();
          const body = await readBody(req);
          const version = typeof body?.version === "string" ? body.version : status.latest ?? "";
          return json(res, 202, serverUpdate.request(version));
        }
      } catch (error) {
        return json(res, (error as { status?: number }).status ?? 500, { error: (error as Error).message });
      }
    }

    // ── the Colonie account of the person on this computer (desktop owner) ──
    if (desktopAccount && path.startsWith("/api/colonie-account")) {
      try {
        if (method === "GET" && path === "/api/colonie-account") return json(res, 200, { required: true, account: desktopAccount.account() });
        if (method === "POST" && path === "/api/colonie-account/start") {
          return json(res, 200, await desktopAccount.start(`${ownOrigin}${DESKTOP_CALLBACK}`));
        }
        if (method === "POST" && path === "/api/colonie-account/sign-out") { desktopAccount.signOut(); return json(res, 200, { ok: true }); }
      } catch (error) {
        return json(res, (error as { status?: number }).status ?? 502, { error: (error as Error).message });
      }
    }

    // ── Shared workspaces on the owner's DigitalOcean account (desktop owner) ──
    if (sharedServers && path.startsWith("/api/shared-servers")) {
      try {
        if (method === "GET" && path === "/api/shared-servers") {
          return json(res, 200, { digitalOcean: await sharedServers.status(), servers: sharedServers.list() });
        }
        if (method === "POST" && path === "/api/shared-servers/digitalocean/connect") {
          return json(res, 200, await sharedServers.connect(`${ownOrigin}${DIGITALOCEAN_CALLBACK}`));
        }
        if (method === "POST" && path === "/api/shared-servers/digitalocean/disconnect") {
          await sharedServers.disconnect();
          return json(res, 200, { ok: true });
        }
        if (method === "POST" && path === "/api/shared-servers/self") {
          const body = await readBody(req);
          const name = typeof body?.name === "string" ? body.name : "";
          if (!name.trim()) return json(res, 400, { error: "Give the workspace a name." });
          return json(res, 201, await sharedServers.createSelfHosted(name, typeof body?.address === "string" ? body.address : ""));
        }
        if (method === "POST" && path === "/api/shared-servers") {
          const body = await readBody(req);
          const name = typeof body?.name === "string" ? body.name : "";
          if (!name.trim()) return json(res, 400, { error: "Give the workspace a name." });
          return json(res, 202, await sharedServers.create(name));
        }
        if (method === "POST" && (m = path.match(/^\/api\/shared-servers\/([\w-]{1,64})\/opened$/))) {
          sharedServers.markOpened(m[1]);
          return json(res, 200, { ok: true });
        }
        if (method === "DELETE" && (m = path.match(/^\/api\/shared-servers\/([\w-]{1,64})$/))) {
          await sharedServers.remove(m[1]);
          return json(res, 200, { ok: true });
        }
      } catch (error) {
        return json(res, (error as { status?: number }).status ?? 502, { error: (error as Error).message });
      }
    }

    // ── bots ──
    const requirePinnedClientThread = pinnedClientThread({ auth, store, shared: () => ownThreads?.shared() ?? false });
    if (method === "GET" && path === "/api/bots") {
      const limit = pageSize(url.searchParams.get("messages"));
      if (limit === null) return json(res, 400, { error: "messages must be a non-negative whole number" });
      // wireBot(), not publicBot(): this snapshot answers with the page it
      // was asked for, not the default one. tasks stays explicit, as in
      // publicBot(): wireBot() omits the key entirely for a bot record
      // carrying no tasks, where clients expect [].
      // A member on a workspace with a restricted bot gets only what they may
      // see (bot-visibility.ts); for everyone else these filters keep all.
      const shownBots = store.bots.filter((bot: any) => visible.bot(bot.id));
      const queued = publicBotQueuedMessages();
      // In a Shared workspace each person's current conversation with a bot is
      // their own (colonie/chat/own-threads.ts), not the bot's shared pointer.
      const person = personOf(auth);
      const shownThread = (bot: any) => ownThreads.currentThread(person, bot) ?? "";
      return json(res, 200, {
        bots: shownBots.map((bot: any) => memberBot({
          ...wireBot(bot),
          tasks: store.tasks(bot.id).map((task: any) => wireTask(task, bot.modelSelection)),
          threadId: shownThread(bot),
          ...(shownThread(bot) ? messagePage(shownThread(bot), limit) : { messages: [] }),
        }, visible)),
        botQueuedMessages: visible.everything ? queued : Object.fromEntries(Object.entries(queued).filter(([threadId]) => visible.thread(threadId))),
        sections: visible.sections(store.sections),
        computerControl: Object.fromEntries(
          shownBots.map((bot: any) => {
            const snapshot = botComputerControlSnapshot(bot.id);
            return [bot.id, { held: snapshot.held, helpReason: snapshot.helpReason }];
          }),
        ),
      });
    }

    // ── Secrets (colonie/secrets): a person's own, never their values ──
    const secrets: Secrets | undefined = deps.secrets;
    if (secrets && (path === "/api/secrets" || path.startsWith("/api/secrets/"))) {
      const caller: Caller | null = deps.conversationCaller(auth);
      if (!caller) return json(res, 403, { error: "sign in to keep secrets" });
      if (method === "GET" && path === "/api/secrets") return json(res, 200, { secrets: secrets.list(caller.key) });
      const name = (m = path.match(/^\/api\/secrets\/([A-Z][A-Z0-9_]{1,63})$/))?.[1];
      if (!name) return json(res, 404, { error: "no such secret" });
      // only bots this person can see may be given one
      const visibleBots = (value: unknown) => Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && caller.seesBot(id)) : undefined;
      try {
        if (method === "PUT") {
          const body = (await readBody(req)) ?? {};
          const botId = typeof body.botId === "string" && caller.seesBot(body.botId) ? body.botId : undefined;
          const secret = secrets.put(caller.key, { name, value: body.value, description: body.description, bots: visibleBots(body.bots), botId });
          // saved from a bot's request in a chat: that card is answered
          if (typeof body.threadId === "string" && typeof body.messageId === "string" && botId) {
            const message = store.messagesFor(body.threadId).find((entry: { id: string; secretAsk?: { name: string } }) => entry.id === body.messageId && entry.secretAsk?.name === name);
            if (message?.secretAsk && store.botByThread(body.threadId)?.id === botId) store.patchMessage(body.threadId, message.id, { secretAsk: { ...message.secretAsk, saved: true } });
          }
          return json(res, 200, { secret });
        }
        if (method === "PATCH") return json(res, 200, { secret: secrets.setBots(caller.key, name, visibleBots(((await readBody(req)) ?? {}).bots) ?? []) });
        if (method === "DELETE") return secrets.remove(caller.key, name) ? json(res, 200, { ok: true }) : json(res, 404, { error: "no such secret" });
      } catch (error) {
        const status = (error as { status?: number }).status ?? 400;
        return json(res, status, { error: error instanceof Error ? error.message : String(error) });
      }
      return json(res, 405, { error: "method not allowed" });
    }

    // ── groups and DMs between people (colonie/groups) ──
    const groupConversations: GroupConversations | undefined = deps.groupConversations;
    if (groupConversations && (path === "/api/people" || path.startsWith("/api/conversations"))) {
      const caller: Caller | null = deps.conversationCaller(auth);
      if (!caller) return json(res, 403, { error: "sign in to talk with people and bots" });
      if (method === "GET" && path === "/api/people") {
        const directory = deps.workspaceDirectory() as Array<{ email: string; name?: string; avatar?: string }>;
        return json(res, 200, { people: directory.map((entry) => ({ email: entry.email, name: entry.name || entry.email, ...(entry.avatar ? { avatar: entry.avatar } : {}) })) });
      }
      let answer: { status: number; body: unknown } | null = null;
      if (method === "GET" && path === "/api/conversations") answer = groupConversations.list(caller);
      else if (method === "POST" && path === "/api/conversations") answer = groupConversations.create(caller, (await readBody(req)) ?? {});
      else if ((m = path.match(/^\/api\/conversations\/([\w-]+)\/messages$/))) {
        answer = method === "GET" ? groupConversations.messages(caller, m[1])
          : method === "POST" ? await groupConversations.post(caller, m[1], (await readBody(req))?.text) : null;
      } else if (method === "POST" && (m = path.match(/^\/api\/conversations\/([\w-]+)\/read$/))) answer = groupConversations.read(caller, m[1]);
      else if (method === "POST" && (m = path.match(/^\/api\/conversations\/([\w-]+)\/members$/))) answer = groupConversations.add(caller, m[1], (await readBody(req)) ?? {});
      else if (method === "DELETE" && (m = path.match(/^\/api\/conversations\/([\w-]+)\/members\/me$/))) answer = groupConversations.leave(caller, m[1]);
      return answer ? json(res, answer.status, answer.body) : json(res, 405, { error: "method not allowed" });
    }

    // the people in a conversation (Shared workspace): list, add, leave
    m = path.match(/^\/api\/threads\/([\w-]+)\/people(\/me)?$/);
    if (m && deps.threadPeople) {
      const me = personOf(auth);
      const answer = method === "GET" && !m[2] ? deps.threadPeople.list(me, m[1])
        : method === "POST" && !m[2] ? deps.threadPeople.add(me, m[1], (await readBody(req))?.email)
        : method === "DELETE" && m[2] ? deps.threadPeople.leave(me, m[1])
        : { status: 405, body: { error: "method not allowed" } };
      return json(res, answer.status, answer.body);
    }

    // scrollback: the page before a message the client already holds
    m = path.match(/^\/api\/threads\/([\w-]+)\/messages$/);
    if (m && method === "GET") {
      const threadId = m[1];
      if (!store.botByThread(threadId) && !store.groupByThread(threadId)) {
        return json(res, 404, { error: "no such conversation" });
      }
      const limit = pageSize(url.searchParams.get("limit"));
      if (limit === null) return json(res, 400, { error: "limit must be a non-negative whole number" });
      const before = url.searchParams.get("before");
      const around = url.searchParams.get("around");
      if (before && around) return json(res, 400, { error: "before and around cannot be combined" });
      if (around) {
        const window = messageWindow(threadId, around, limit ?? DEFAULT_PAGE);
        if (!window) return json(res, 404, { error: "no such message" });
        return json(res, 200, { ...window, activeLeafId: store.activeLeaf(threadId) });
      }
      // An unknown cursor must not silently answer with the newest page —
      // the client would paginate in a circle and never reach the top.
      if (before && !store.messagesFor(threadId).some((msg: any) => msg.id === before)) {
        return json(res, 404, { error: "no such message" });
      }
      return json(res, 200, { ...messagePage(threadId, limit ?? DEFAULT_PAGE, before), activeLeafId: store.activeLeaf(threadId) });
    }

    // the pixels of one screen message, fetched only when something shows it
    m = path.match(/^\/api\/threads\/([\w-]+)\/messages\/([\w-]+)\/image$/);
    if (m && method === "GET") {
      // Same guard as the page route above, and for the same reason twice
      // over: an unknown id should 404 deliberately rather than by accident,
      // and `messagesFor` materialises and caches a ThreadState for whatever
      // it is handed. Without this, a client asking for images on ids that
      // do not exist grows the thread map for as long as it keeps asking.
      if (!store.botByThread(m[1]) && !store.groupByThread(m[1])) {
        return json(res, 404, { error: "no such conversation" });
      }
      const message = store.messagesFor(m[1]).find((msg: any) => msg.id === m![2]);
      if (!message?.png) return json(res, 404, { error: "no image on that message" });
      const bytes = Buffer.from(message.png, "base64");
      res.writeHead(200, {
        "content-type": message.mime ?? "image/png",
        "content-length": String(bytes.byteLength),
        // a settled message's image never changes
        "cache-control": "private, max-age=31536000, immutable",
      });
      return res.end(bytes);
    }

    // Download one local file only when this exact stored message grants it:
    // a bot must render a Markdown link or carry a generated-image attachment,
    // while a user message must carry the standalone composer tag. The bot
    // branch derives conversation/workspace roots; the user branch is limited
    // to Colonie's private attachment directory. This is deliberately not
    // a general path reader.
    m = path.match(/^\/api\/threads\/([\w-]+)\/messages\/([\w-]+)\/file$/);
    const streamsMessageImage = Boolean(
      m && method === "GET" && url.searchParams.get("preview") === "1",
    );
    if (m && (method === "POST" || streamsMessageImage)) {
      if (method === "POST" && !String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const threadId = m[1]!;
      const directBot = store.botByThread(threadId);
      const group = directBot ? undefined : store.groupByThread(threadId);
      if (!directBot && !group) return json(res, 404, { error: "no such conversation" });

      const message = store.messagesFor(threadId).find((candidate: any) => candidate.id === m![2]);
      if (!message) return json(res, 404, { error: "no such message" });
      if (message.kind !== "text" || (!message.text && !message.attachments?.length)) {
        return json(res, 403, { error: "that message does not share this file" });
      }
      const messageText = message.text ?? "";
      const body = method === "POST" ? await readBody(req) : null;
      const rawReference = streamsMessageImage ? url.searchParams.get("ref") : null;
      if (streamsMessageImage && (!rawReference || !/^\d+$/.test(rawReference))) {
        return json(res, 400, { error: "ref must identify a rendered image" });
      }
      const href = method === "POST"
        ? (typeof body.path === "string" ? body.path : "")
        : messageImageTargetAt(messageText, Number(rawReference));
      if (!href) return json(res, 400, { error: "path is required" });

      let roots: string[];
      let downloadName: string | undefined;
      // A file the bot attached with attach_file lives in the private
      // attachment store; the message itself is the grant, exactly as a
      // user's attachment tag is for their own uploads.
      const botAttachment = message.role === "bot"
        ? message.attachments?.find((attachment: any) => attachment.path === href)
        : undefined;
      if (message.role === "user") {
        downloadName = messageAttachmentName(messageText, href) ?? undefined;
        if (!downloadName) {
          return json(res, 403, { error: "that message does not share this file" });
        }
        roots = [ATTACHMENTS_DIR];
      } else if (botAttachment) {
        // Files and images alike: the stored message is the grant, so the
        // mobile clients can fetch an attached image through this route too.
        downloadName = botAttachment.kind === "file" ? botAttachment.name : undefined;
        roots = [ATTACHMENTS_DIR];
      } else {
        if (!messageReferencesFile(messageText, href)) {
          return json(res, 403, { error: "that bot message does not link to this file" });
        }
        const senderId = directBot?.id ?? message.from?.botId;
        // The persisted bot-role message is the author record. Membership is
        // intentionally not consulted: removing a bot must not break files it
        // already shared in channel history.
        if (!senderId) {
          return json(res, 403, { error: "the file's bot author could not be verified" });
        }
        roots = messageFileRootsForThread(senderId, threadId);
      }

      // A link to a folder answers with its files; each one is then fetched
      // by plain name under the same message grant and file checks.
      const folderEntry = method === "POST" && body.entry !== undefined
        ? messageFolderEntryName(body.entry)
        : undefined;
      if (folderEntry === null) return json(res, 400, { error: "entry must be one file name" });
      let file: Awaited<ReturnType<typeof openMessageFile>>;
      try {
        file = folderEntry
          ? await openMessageFolderEntry(href, folderEntry, roots)
          : await openMessageFile(href, roots);
      } catch (error) {
        // Only a client that asks for listings gets one; older clients keep the 400.
        if (body?.listFolder !== true || folderEntry || (error as { code?: unknown } | null)?.code !== "directory") throw error;
        const listing = await listMessageFolder(href, roots);
        res.setHeader("x-colonie-folder", "1");
        res.setHeader("cache-control", "private, no-store");
        return json(res, 200, listing);
      }
      if ((streamsMessageImage || botAttachment?.kind === "image") && !file.mime.startsWith("image/")) {
        await file.handle.close();
        return json(res, 415, { error: "only images can be previewed here" });
      }
      res.writeHead(200, {
        "content-type": file.mime,
        "content-length": String(file.bytes),
        ...(streamsMessageImage
          ? { "content-disposition": "inline" }
          : { "content-disposition": messageFileDisposition(messageFileDownloadName(downloadName, file.name)) }),
        "cache-control": streamsMessageImage ? "private, max-age=3600" : "private, no-store",
        "cdn-cache-control": "no-store",
        "cloudflare-cdn-cache-control": "no-store",
        pragma: "no-cache",
        vary: "Authorization",
        "x-content-type-options": "nosniff",
        ...(streamsMessageImage
          ? {
              "cross-origin-resource-policy": "same-origin",
              "referrer-policy": "no-referrer",
            }
          : {}),
      });
      if (file.bytes === 0) {
        await file.handle.close();
        return res.end();
      }
      const stream = file.handle.createReadStream({ start: 0, end: file.bytes - 1, autoClose: true });
      stream.on("error", () => res.destroy());
      res.on("close", () => stream.destroy());
      stream.pipe(res);
      return;
    }

    // ── image attachments ────────────────────────────────────────────────
    // Pasted/dropped images are stored as files and referenced by path in
    // the prompt (<attached-image path="…"/>); this pair of routes is the
    // save + serve. The POST takes raw bytes (base64 JSON would double the
    // payload), so it needs its own reader rather than readBody. A share
    // extension can add a UUID uploadId; retrying that UUID returns the same
    // committed path instead of creating an orphan duplicate.

    // serving is name-locked to the attachments dir — readAttachment
    // refuses anything that is not a bare generated filename
    m = path.match(/^\/api\/attachments\/([\w.-]+)$/);
    if (m && method === "GET") {
      const attachment = readAttachment(m[1]!);
      if (!attachment) return json(res, 404, { error: "no such attachment" });
      const size = attachment.bytes.byteLength;
      // Who may see an attachment is decided per request — the dispatcher
      // 404s hidden ones above — so the browser must never reuse one
      // member's copy after a switch to another identity in the same profile.
      const headers = {
        "content-type": attachment.mime,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      };
      // Range serving is audio-only (#1745): a player scrubbing a voice note
      // asks for byte windows, and images/documents keep the full response
      // the app has always relied on. A header we do not understand reads
      // as absent — the full 200 is always a correct answer to a GET.
      if (attachment.mime.startsWith("audio/")) {
        const rawRange = Array.isArray(req.headers.range) ? req.headers.range[0] : req.headers.range;
        const range = parseAudioRange(rawRange, size);
        if (range.kind === "unsatisfiable") {
          res.writeHead(416, { ...headers, "content-range": `bytes */${size}` });
          return res.end();
        }
        if (range.kind === "range") {
          res.writeHead(206, {
            ...headers,
            "content-length": String(range.end - range.start + 1),
            "content-range": `bytes ${range.start}-${range.end}/${size}`,
          });
          return res.end(attachment.bytes.subarray(range.start, range.end + 1));
        }
      }
      res.writeHead(200, { ...headers, "content-length": String(size) });
      return res.end(attachment.bytes);
    }

    // ── search across every transcript ──────────────────────────────────
    // Literal substring scans run in a bounded read-only worker so a large
    // history cannot stall unrelated turns. Hits resolve to the owning bot/room;
    // rows belonging to deleted conversations resolve to nothing and drop.
    if (method === "GET" && path === "/api/search") {
      const q = url.searchParams.get("q") ?? "";
      const rawLimit = url.searchParams.get("limit");
      const limit = rawLimit ? Math.min(Math.max(Number(rawLimit) || 0, 1), 100) : 40;
      const threadId = url.searchParams.get("threadId")?.trim() || undefined;
      if (threadId && ((!store.botByThread(threadId) && !store.groupByThread(threadId)) || !visible.thread(threadId))) {
        return json(res, 404, { error: "no such conversation" });
      }
      // whether each hit sits on its thread's visible branch — a click on
      // one that does not has to switch versions first (and only then)
      const activePaths = new Map<string, Set<string>>();
      const onActivePath = (threadId: string, messageId: string) => {
        let ids = activePaths.get(threadId);
        if (!ids) activePaths.set(threadId, (ids = new Set(store.activePath(threadId).map((m: any) => m.id))));
        return ids.has(messageId);
      };
      // A member who may not see every bot: look further, then keep only
      // hits in conversations they can open. A person in a Shared workspace
      // has the scan itself limited to their own conversations, so someone
      // else's many matches can never crowd theirs out of the page.
      const allowedThreads = deps.ownThreadIds?.(auth) ?? null;
      const found = await searchMessagesAsync(
        q,
        allowedThreads || visible.everything ? limit : Math.min(limit * 10, 1_000),
        threadId,
        allowedThreads ?? undefined,
      );
      // A scan may outlive a revocation or audience edit. Authorize again
      // after the await, and resolve visibility from current store state.
      if (HOSTED_WORKSPACE && auth.kind === "session") {
        const failure = workspaceAccess() ? await workspaceAccess().authorize(req, auth)
          : { status: 503, error: "Workspace sign-in is unavailable." };
        if (failure) return json(res, failure.status, { error: failure.error });
      }
      const current = resolveRequestAuth(req, {
        sessions, cookieName: SESSION_COOKIE, streamPath: "/api/events", url,
        loopbackMutationToken: desktopMutationToken(),
        features: { sharedComputers: lendingEnabled() }, loopbackTrust: LOOPBACK.trust,
      });
      if (!current.auth) return json(res, current.status, { error: current.error });
      const currentVisible = visibleTo(viewerFor(current.auth));
      if (threadId && !currentVisible.thread(threadId)) return json(res, 404, { error: "no such conversation" });
      const hits = found
        .filter((hit) => currentVisible.thread(hit.threadId))
        .slice(0, limit)
        .map((hit) => {
          const bot = store.botByThread(hit.threadId);
          const group = bot ? undefined : store.groupByThread(hit.threadId);
          if (!bot && !group) return null;
          const active = onActivePath(hit.threadId, hit.messageId);
          if (bot) {
            const task = store.taskByThread(bot.id, hit.threadId);
            return { ...hit, botId: bot.id, name: bot.name, task: task?.title, onActivePath: active };
          }
          if (group) {
            const task = store.groupTaskByThread(group.id, hit.threadId);
            return { ...hit, groupId: group.id, name: group.name, task: task?.title, onActivePath: active };
          }
          return null;
        })
        .filter((hit): hit is NonNullable<typeof hit> => hit !== null);
      return json(res, 200, { hits });
    }

    // ── transcript export (the visible branch, human-readable) ──────────
    m = path.match(/^\/api\/threads\/([\w-]+)\/export$/);
    if (m && method === "GET") {
      const threadId = m[1];
      const bot = store.botByThread(threadId);
      const group = bot ? undefined : store.groupByThread(threadId);
      if (!bot && !group) return json(res, 404, { error: "no such conversation" });
      const format = url.searchParams.get("format") ?? "markdown";
      if (format !== "markdown" && format !== "json") {
        return json(res, 400, { error: "format must be markdown or json" });
      }
      const title = bot
        ? (store.taskByThread(bot.id, threadId)?.title || bot.name)
        : (store.groupTaskByThread(group!.id, threadId)?.title || group!.name);
      const filename = (title.replace(/[^\w\- ]+/g, "").trim() || "conversation").slice(0, 60);
      const messages = store.activePath(threadId);
      if (format === "json") {
        // pixels stripped — an export is for reading and archiving, and a
        // base64 desktop frame is neither
        const slim = messages.map(({ png: _png, mime: _mime, ...rest }: any) => rest);
        res.writeHead(200, {
          "content-type": "application/json",
          "content-disposition": `attachment; filename="${filename}.json"`,
        });
        return res.end(JSON.stringify({ name: title, threadId, messages: slim }, null, 2));
      }
      const userName = cfg.profile?.name?.trim() || "User";
      const lines: string[] = [`# ${title}`, ""];
      for (const msg of messages) {
        const sentBy = msg.sender?.name ?? userName;
        const who = msg.role === "user"
          ? msg.via === "api" ? `${sentBy} (via the local API)` : sentBy
          : (msg.from?.name ?? bot?.name ?? "Bot");
        if (msg.kind === "text" && msg.text) lines.push(`**${who}:**`, "", msg.text, "");
        else if (msg.kind === "activity" && msg.tool) lines.push(`> ${msg.tool.name}`, "");
        else if (msg.kind === "screen") lines.push("> [screen capture]", "");
        else if (msg.kind === "options" && msg.card) {
          lines.push(`> ${msg.card.title}${msg.card.answered ? ` — answered: ${msg.card.answered}` : ""}`, "");
        }
      }
      res.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}.md"`,
      });
      return res.end(lines.join("\n"));
    }

    m = path.match(/^\/api\/bots\/([\w-]+)\/avatar\/generate$/);
    if (m && method === "POST") {
      const existing = store.bot(m[1]);
      if (!existing) return json(res, 404, { error: "no such bot" });
      // Generation is slow and both desktop and companion clients may edit or
      // delete this bot while it is in flight. Snapshot the two fields this
      // request owns before the first await so a late result cannot win.
      const initialAvatar = snapshotAvatarGenerationState(existing);
      const parsed = avatarGenerationRequestSchema.safeParse(await readBody(req));
      if (!parsed.success) {
        return json(res, 400, { error: `prompt must be at most 400 characters` });
      }
      const generated = await generateAvatarImage(cfg, existing, parsed.data.prompt);
      const current = store.bot(existing.id);
      if (!current) return json(res, 404, { error: "no such bot" });
      if (!avatarGenerationStateMatches(initialAvatar, current)) {
        return json(res, 409, { error: "avatar changed while generation was in progress" });
      }
      const saved = saveImage(generated.bytes, generated.mime);
      const avatarUrl = botAvatarUrlFromStoredPath(saved.path);
      if (!avatarUrl) throw Object.assign(new Error("Could not store the generated avatar"), { status: 500 });
      const avatarCrop = initialAvatar.avatarCrop && initialAvatar.avatarCrop !== "mascot"
        ? initialAvatar.avatarCrop
        : "circle";
      const bot = store.patchBot(current.id, { avatarUrl, avatarCrop });
      if (!bot) {
        // There are no awaits between the refreshed lookup and this patch, but
        // keep the attachment invariant explicit if the store ever changes.
        deleteAttachment(saved.path);
        return json(res, 404, { error: "no such bot" });
      }
      const visible = wireBot(bot);
      broadcast({ kind: "bot", bot: visible });
      return json(res, 201, { avatarUrl, bot: visible });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/model$/);
    if (m && method === "PATCH") {
      const body = await readBody(req);
      if (body && typeof body === "object" && !Array.isArray(body)) {
        const unsupported = Object.keys(body).find(
          (key) => key !== "instanceId" && key !== "model" && key !== "effort" && key !== "variant",
        );
        if (unsupported) return json(res, 400, { error: `unsupported model field: ${unsupported}` });
      }
      const existing = store.bot(m[1]);
      if (!existing) return json(res, 404, { error: "no such bot" });
      requirePinnedClientThread(existing.id, undefined);
      // The bot's model is the bot's; the caller's selected conversation, when
      // they have one, follows it too (deps.selectedTaskBot, null when none).
      const selected = deps.selectedTaskBot ? deps.selectedTaskBot(existing.id, auth) : requestedTaskBot(existing.id, undefined, auth);
      if (existing.approvalGrant) {
        return json(res, 409, { error: "wait for the approval-level change to finish before changing models" });
      }
      const checked = checkedModelSelection(
        body,
        selected ? { selection: selected.modelSelection, busy: threadBusy(selected.id, selected.threadId) } : { selection: existing.modelSelection, busy: false },
        true,
      );
      if (!checked.ok) return json(res, checked.status, { error: checked.error });
      if ([existing, ...(selected ? [selected] : [])].some((owner) => {
        const mode = approvalModeFor(owner);
        return (mode === "full" || mode === "custom") &&
          (!supportsApprovalMode(checked.selection, mode) ||
            registry.cliTarget(checked.selection.instanceId)?.driverKind !== registry.cliTarget(owner.modelSelection.instanceId)?.driverKind);
      })) {
        return json(res, 400, {
          error: "Changing providers with elevated permissions requires choosing Ask first",
        });
      }
      // patchBot persists first and emits the canonical bot change, which the
      // store listener above turns into the slim wire-format SSE broadcast.
      // Every thread that follows the bot moves with it; the selected thread
      // follows it from now on too, as if picked there.
      const bot = store.patchBot(existing.id, { modelSelection: checked.selection });
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (selected) store.patchTask(bot.id, selected.threadId, { modelSelection: undefined });
      return json(res, 200, { bot: wireBot(bot) });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/always-allow$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      requirePinnedClientThread(m[1], body?.threadId);
      const allowKey = typeof body.allowKey === "string" ? body.allowKey : "";
      const bot = requestedTaskBot(m[1], body.threadId, auth);
      if (!allowKey) return json(res, 400, { error: "allowKey required" });
      const pending = store.messagesFor(bot.threadId).find((message: any) =>
        message.card?.requestId &&
        !message.card.answered &&
        message.card.dismissed !== true &&
        message.card.allowKey === allowKey
      );
      if (!pending) {
        return json(res, 409, { error: "that grant is not on a pending approval for this bot" });
      }
      // A standing grant is an approval: the same people who may approve
      // the card it came from may remember it.
      const refusal = cardAnswerRefusal(auth, bot.threadId, pending.card!.requestId!, "allow");
      if (refusal) return json(res, 403, { error: refusal });
      store.patchTask(bot.id, bot.threadId, {
        alwaysAllow: [...new Set([...(bot.alwaysAllow ?? []), allowKey])].slice(0, 200),
      });
      const live = directTurnBots.get(bot.threadId);
      if (live) live.alwaysAllow = [...new Set([...(live.alwaysAllow ?? []), allowKey])].slice(0, 200);
      const updated = store.bot(bot.id)!;
      const visible = wireBot(updated);
      broadcast({ kind: "bot", bot: visible });
      return json(res, 200, { bot: visible });
    }

    if (method === "POST" && path === "/api/local-computer/interrupt") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      await Promise.allSettled(
        store.bots
          .filter((bot: any) => bot.computer === "local")
          .map(async (bot: any) => {
            // Cancel the routine run before interrupting direct threads: the
            // interrupt ends the run's turn, and the routine scheduler would
            // record that early exit as `failed` before cancelRun could mark
            // the run `cancelled`. Same order as the bot-wide stop.
            const routineRun = routines()!.activeBotRunForBot(bot.id);
            if (routineRun) {
              if (routineRun.threadId) revokeInternalCapabilitiesForThread(routineRun.threadId);
              cancelDirectTurnDispatch(bot.id, routineRun.threadId);
              await routines()!.cancelRun(routineRun.id);
            }
            await interruptAllDirectThreads(bot.id);
          }),
      );
      return json(res, 200, { ok: true });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)$/);
    if (m && method === "DELETE") {
      const result = await deleteBotWithLifecycle(m[1]);
      return json(res, result.status, result.body);
    }

    // ── bot skills: imported Agent Skills (SKILL.md) ────────────────────
    // Import lands DISABLED; the UI shows SKILL.md + scan warnings and a
    // person enables after reading. See server/skills.ts for the policy.
    m = path.match(/^\/api\/bots\/([\w-]+)\/skill-template$/);
    if (m && method === "POST") {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      const checked = botSkillTemplateSchema.safeParse(await readBody(req));
      if (!checked.success) return json(res, 400, { error: checked.error.message });
      const input = checked.data;
      const parsed = parseSkillMd(input.text);
      if ("error" in parsed || parsed.name !== input.name) return json(res, 400, { error: "Skill name does not match its contents" });
      const installed = installSkill(m[1], input.source, [{ path: "SKILL.md", content: input.text }]);
      if ("error" in installed) return json(res, 422, { error: installed.error });
      if (input.enabled) {
        const enabled = setSkillEnabled(m[1], input.name, true);
        if ("error" in enabled) return json(res, 422, { error: enabled.error });
      }
      return json(res, 201, { installed });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/skills$/);
    if (m && method === "GET") {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      if (skillsLibraryEnabled(cfg)) {
        const { skills, library } = listBotSkillsWithOrigin(m[1]!, store.bot(m[1])!.assignedSkills);
        return json(res, 200, {
          skills,
          library,
          // the authoritative assignment list: merged rows hide
          // assignments a same-name private skill shadows
          assignedSkills: store.bot(m[1])!.assignedSkills,
          staged: listStagedSkillWrites(m[1]).map(stagedSkillListing),
        });
      }
      return json(res, 200, {
        skills: listBotSkills(store.bot(m[1])!),
        staged: listStagedSkillWrites(m[1]).map(stagedSkillListing),
      });
    }
    if (m && method === "POST") {
      if (!store.bot(m[1])) return json(res, 404, { error: "no such bot" });
      const parsed = z.object({ source: z.string().min(1).max(2000) }).safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "source must be a GitHub or skills.sh URL, or owner/repo" });
      const fetched = await fetchSkillFromSource(parsed.data.source);
      if ("error" in fetched) return json(res, 422, { error: fetched.error });
      const results = fetched.skills.map((skill) => installSkill(m![1]!, skill.source, skill.files));
      const installed = results.filter((entry): entry is Exclude<typeof entry, { error: string }> => !("error" in entry));
      const errors = results.flatMap((entry) => ("error" in entry ? [entry.error] : []));
      if (!installed.length) return json(res, 422, { error: errors.join("; ") || "nothing importable found" });
      return json(res, 201, { installed, errors });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/skills\/([a-z0-9-]+)$/);
    if (m && method === "GET") {
      const bot = store.bot(m[1]);
      const text = bot ? readBotSkillFile(bot, m[2]!) : null;
      if (text === null) return json(res, 404, { error: "no such skill" });
      return json(res, 200, { text });
    }
    if (m && method === "PATCH") {
      const parsed = z.object({ enabled: z.boolean() }).safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "enabled must be true or false" });
      const result = setSkillEnabled(m[1]!, m[2]!, parsed.data.enabled);
      if ("error" in result) return json(res, 404, { error: result.error });
      return json(res, 200, { skill: result });
    }
    if (m && method === "DELETE") {
      const result = removeSkill(m[1]!, m[2]!);
      if ("error" in result) return json(res, 404, { error: result.error });
      return json(res, 200, { ok: true });
    }


    // onboarding/ask cards persist their answered/dismissed state
    m = path.match(/^\/api\/bots\/([\w-]+)\/cards\/([\w-]+)$/);
    if (m && method === "PATCH") {
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return json(res, 400, { error: "body must be a JSON object" });
      }
      const bot = requestedTaskBot(m[1], body.threadId, auth);
      const existing = store.messagesFor(bot.threadId).find((msg: any) => msg.id === m![2]);
      if (!existing?.card) return json(res, 404, { error: "no such card" });
      if (existing.card.requestId) {
        return json(res, 409, { error: "request cards must be answered through the approval endpoint" });
      }
      if (Object.keys(body).some((key) => key !== "answered" && key !== "dismissed" && key !== "threadId")) {
        return json(res, 400, { error: "only answered and dismissed may be changed" });
      }
      if (body.answered !== undefined && typeof body.answered !== "string") {
        return json(res, 400, { error: "answered must be a string" });
      }
      if (body.dismissed !== undefined && typeof body.dismissed !== "boolean") {
        return json(res, 400, { error: "dismissed must be true or false" });
      }
      const patched = store.patchMessage(bot.threadId, m[2], {
        card: {
          ...existing.card,
          ...(body.answered !== undefined ? { answered: body.answered } : {}),
          ...(body.dismissed !== undefined ? { dismissed: body.dismissed } : {}),
        },
      });
      return json(res, 200, { message: patched });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/requests\/([A-Za-z0-9_-]{16,80})(\/interrupt)?$/);
    if (m && ((method === "GET" && !m[3]) || (method === "POST" && m[3]))) {
      const body = method === "GET" ? { threadId: url.searchParams.get("threadId") } : await readBody(req);
      const id = z.string().regex(/^[\w-]+$/);
      const parsed = (method === "GET" ? z.object({ threadId: id }).strict() : z.object({
        threadId: id, messageId: id, expectedActiveLeafId: id.nullable(),
        expectedTurnId: z.string().min(1).max(200).nullable(), expectedExecutionId: id.nullable(),
      }).strict()).safeParse(body);
      if (!parsed.success) return json(res, 400, { error: "A pinned thread and exact request snapshot are required" });
      const threadId = parsed.data.threadId;
      const snapshot = guardedRequestSnapshot(m[1], threadId, m[2]);
      res.setHeader("cache-control", "private, no-store");
      if (method === "GET") return json(res, 200, snapshot);
      assertRequestTarget(snapshot, body);
      const owner = directRequestOwners.get(threadId);
      if (snapshot.phase === "untracked" || !owner || owner.messageId !== snapshot.messageId) {
        return json(res, 409, { error: "This continuation cannot be safely stopped from this interface", code: "guarded_request_untracked" });
      }
      if (snapshot.phase === "settled") throw requestConflict("This request has already settled");
      // No await between comparing the exact lease and revoking it. Retrying
      // this body cannot bind to a later setup claim with a null provider id.
      owner.stopped = true;
      handoffs.stoppedByPerson(threadId);
      await interruptDirectThread(m[1], threadId);
      return json(res, 200, { ok: true, outcome: "stopped" });
    }

    m = path.match(/^\/api\/bots\/([\w-]+)\/queue\/([\w-]+)$/);
    if (m && method === "DELETE") {
      const body = await readBody(req);
      requirePinnedClientThread(m[1], body?.threadId);
      const bot = requestedTaskBot(m[1], body?.threadId, auth);
      const queueId = m[2];
      if (!cancelSteeredMessage(bot.id, queueId, bot.threadId)) {
        return json(res, 404, { error: "no such queued message" });
      }
      return json(res, 200, { ok: true });
    }

    // Steer a queued message into the RUNNING turn (no interrupt). Engines
    // without a live steer keep the queue; this never ends the current turn.

    // Compaction shares normal turn admission and Stop, but never executes
    // an agent turn or provisions a computer. It preserves the full history.
    m = path.match(/^\/api\/bots\/([\w-]+)\/compact$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      requirePinnedClientThread(m[1], body?.threadId);
      const bot = requestedTaskBot(m[1], body?.threadId, auth);
      await startTurn(bot.id, "Summarize conversation context", {
        threadId: bot.threadId, compactOnly: true, cardContinuation: true, trigger: usageTriggerFor(auth),
      });
      return json(res, 202, { ok: true, threadId: bot.threadId });
    }

    // edit a user message → fork the conversation there and rerun the turn.
    // Rewinding a live thread is refused, exactly like switching versions
    // below: interrupting mid-flight and branching under the dying turn is
    // how a conversation ends up with two tails. Stop, then edit.
    m = path.match(/^\/api\/bots\/([\w-]+)\/messages\/([\w-]+)\/edit$/);
    if (m && method === "POST") {
      const messageId = m[2];
      const body = await readBody(req);
      requirePinnedClientThread(m[1], body?.threadId);
      const bot = requestedTaskBot(m[1], body.threadId, auth);
      const text = String(body.text ?? "").trim();
      if (!text) return json(res, 400, { error: "text required" });
      const threadMessages = store.messagesFor(bot.threadId);
      const source = threadMessages.find((msg: any) => msg.id === messageId);
      if (!source || source.role !== "user" || source.kind !== "text") {
        return json(res, 404, { error: "only user messages can be edited" });
      }
      // The client's id for this edit. A retry of an edit the server already
      // forked answers with that fork instead of forking (and rerunning) again.
      // Checked before the busy guard: that fork's own turn is what is busy.
      const sendId = parseSendId(body.sendId);
      if (sendId) {
        const accepted = acceptedSendMatch(threadMessages, sendId, text, source.replyToId);
        if (accepted.kind === "conflict" || (accepted.kind === "match" && (accepted.message.parentId ?? null) !== (source.parentId ?? null))) {
          return json(res, 409, { error: "sendId already belongs to another message" });
        }
        if (accepted.kind === "match") return json(res, 202, { ok: true, message: accepted.message });
      }
      // everything from here down is synchronous, so two racing edits can
      // never both get past this check: startTurn flips busy before the
      // next request is handled
      if (threadBusy(bot.id, bot.threadId)) return json(res, 409, { error: "the thread is working — stop it before editing" });
      // A thread's own model that can't run gives way to the bot's when the
      // rerun starts (healThreadModel), so check the model it will run on.
      const rerunSelection = turnSelection(bot.id, bot.threadId) ?? bot.modelSelection;
      if (!registry.get(rerunSelection.instanceId)) {
        return json(res, 409, {
          error: `provider instance "${rerunSelection.instanceId}" is unavailable — pick another model in settings`,
        });
      }
      // startTurn admits the rerun before branching. A shared-resource or
      // concurrency-limit refusal must leave the original transcript intact.
      const replyTo = source.replyToId ? resolveReplyTarget(bot.threadId, source.replyToId) : undefined;
      const message = await startTurn(bot.id, text, { threadId: bot.threadId, editedMessageId: messageId, replyTo, sendId, trigger: usageTriggerFor(auth) });
      return json(res, 202, { ok: true, message });
    }

    // switch which fork of the conversation is visible (no new turn)
    m = path.match(/^\/api\/bots\/([\w-]+)\/active-branch$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      requirePinnedClientThread(m[1], body?.threadId);
      const bot = requestedTaskBot(m[1], body.threadId, auth);
      // The named leaf must be in the conversation being switched. In a Shared
      // workspace a message in someone else's conversation is not found, the
      // same as a thread that is not theirs.
      if (ownThreads?.shared() && !store.messagesFor(bot.threadId).some((msg: any) => msg.id === String(body.messageId ?? ""))) {
        return json(res, 404, { error: "no such message" });
      }
      if (threadBusy(bot.id, bot.threadId)) return json(res, 409, { error: "the thread is working — stop it before switching versions" });
      if (isColonieAcpDriver(registry.get(bot.modelSelection.instanceId)?.driverKind)) return json(res, 409, { error: "Native ACP history switching is not available. Start a new thread." });
      const leaf = store.setActiveLeaf(bot.threadId, String(body.messageId ?? ""));
      if (!leaf) return json(res, 404, { error: "no such message" });
      // provider sessions still hold the other branch — next turn replays
      store.patchTask(bot.id, bot.threadId, { rewound: true });
      return json(res, 200, { activeLeafId: leaf });
    }
    // Answer by THREAD, so a request raised inside a room can be answered
    // too: a member's turn runs on the room's thread, and the bot that
    // owns the pending request is the one currently speaking there.
    m = path.match(/^\/api\/bots\/([\w-]+)\/interrupt$/);
    if (m && method === "POST") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const rawBody = await readBody(req);
      if (rawBody !== null && (typeof rawBody !== "object" || Array.isArray(rawBody))) {
        return json(res, 400, { error: "body must be a JSON object" });
      }
      const body = rawBody ?? {};
      if (body.threadId === "") delete body.threadId; // no conversation yet: none named
      requirePinnedClientThread(bot.id, body.threadId);
      if (body.threadId !== undefined && (typeof body.threadId !== "string" || !/^[\w-]+$/.test(body.threadId))) {
        return json(res, 400, { error: "threadId must be a task id" });
      }
      // In a Shared workspace the stop lands on the person's own conversation:
      // the one the body names, or their current one. Someone else's
      // conversation is not found, so a stop cannot reach it.
      const expectedThreadId: string | undefined = ownThreads?.shared()
        ? requestedTaskBot(bot.id, body.threadId, auth).threadId
        : body.threadId;
      // Explicit thread targets never fall through to another routine or
      // channel just because it belongs to the same bot.
      if (typeof expectedThreadId === "string" && store.taskByThread(bot.id, expectedThreadId)) {
        const routine = routines()!.activeBotRunForBot(bot.id);
        if (routine?.threadId === expectedThreadId) await routines()!.cancelRun(routine.id);
        else {
          handoffs.stoppedByPerson(expectedThreadId);
          await interruptDirectThread(bot.id, expectedThreadId);
        }
        return json(res, 200, { ok: true });
      }
      const directClaim = directTurnDispatchClaims.get(bot.threadId);
      const routineRun = routines()!.activeBotRunForBot(bot.id);
      if (routineRun) {
        if (expectedThreadId !== undefined && routineRun.threadId !== expectedThreadId) {
          return json(res, 409, { error: "this bot is running a routine in another conversation" });
        }
        cancelDirectTurnDispatch(bot.id, routineRun.threadId ?? expectedThreadId);
        if (routineRun.threadId) {
          revokeInternalCapabilitiesForThread(routineRun.threadId);
        }
        await routines()!.cancelRun(routineRun.id);
        return json(res, 200, { ok: true });
      }
      if (
        expectedThreadId !== undefined &&
        bot.threadId !== expectedThreadId &&
        directClaim?.threadId !== expectedThreadId
      ) {
        return json(res, 409, { error: "the bot switched tasks before it could be interrupted" });
      }
      handoffs.stoppedByPerson(expectedThreadId ?? bot.threadId);
      await interruptDirectThread(bot.id, expectedThreadId ?? bot.threadId);
      return json(res, 200, { ok: true });
    }

    // ── tasks: a bot's separate contexts ────────────────────────────────
    // Replies carry the open thread's newest page: a create or delete can
    // change which transcript is live. The frames come from store.onChange.

    // Folders organize one bot's threads; they never own settings,
    // transcripts or working directories. The project wire names stay stable.
    m = path.match(/^\/api\/bots\/([\w-]+)\/projects\/order$/);
    if (m && method === "PATCH") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).some((key) => key !== "projectIds") ||
        !Array.isArray(body.projectIds) || body.projectIds.some((id: unknown) => typeof id !== "string")) {
        return json(res, 400, { error: "projectIds must be an array of folder IDs" });
      }
      const projects = store.reorderProjects(bot.id, body.projectIds);
      if (!projects) return json(res, 400, { error: "projectIds must include each of this bot's folders exactly once" });
      return json(res, 200, { projects, bot: publicBot(bot) });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/projects(?:\/([\w-]+))?$/);
    if (m && ((method === "POST" && !m[2]) || (method === "PATCH" && m[2]) || (method === "DELETE" && m[2]))) {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (m[2] && !store.project(bot.id, m[2])) return json(res, 404, { error: "no such folder" });
      if (method === "DELETE") {
        const updated = store.deleteProject(bot.id, m[2]!);
        return json(res, 200, { bot: publicBot(updated!) });
      }
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "body must be a JSON object" });
      if (Object.keys(body).some((key) => key !== "name" && key !== "emoji")) {
        return json(res, 400, { error: "unsupported folder setting" });
      }
      if ((method === "POST" || body.name !== undefined) &&
        (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 80)) {
        return json(res, 400, { error: "folder name must be between 1 and 80 characters" });
      }
      if (body.emoji !== undefined && body.emoji !== null && !isProjectEmoji(body.emoji)) {
        return json(res, 400, { error: "folder emoji must be one emoji, or null to reset it" });
      }
      const patch: any = {};
      if (body.name !== undefined) patch.name = body.name.trim();
      if (body.emoji !== undefined) patch.emoji = body.emoji;
      const project = method === "POST"
        ? store.createProject(bot.id, patch.name!, patch.emoji)
        : store.patchProject(bot.id, m[2]!, patch);
      return json(res, method === "POST" ? 201 : 200, { project, bot: publicBot(bot) });
    }

    m = path.match(/^\/api\/bots\/([\w-]+)\/tasks$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "body must be a JSON object" });
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (body.approvalMode !== undefined && body.approvalMode !== "ask" && body.approvalMode !== "full") {
        return json(res, 400, { error: "new task approvalMode must be ask or full" });
      }
      if (body.approvalMode === "full") {
        if (auth.kind !== "loopback" || !sharedWorkspaceFullAccessEnabled()) {
          return json(res, 403, { error: "New Full tasks require the operator's dedicated shared-workspace policy" });
        }
        if (bot.approvalGrant) return json(res, 409, { error: "the bot's approval mode is still being confirmed" });
        if (!supportsApprovalMode(bot.modelSelection, "full")) {
          return json(res, 400, { error: "This provider does not support Full access" });
        }
      }
      if (body.projectId !== undefined && (typeof body.projectId !== "string" || !store.project(bot.id, body.projectId))) {
        return json(res, 400, { error: "projectId must belong to this bot" });
      }
      const task = store.createTask(bot.id, typeof body.title === "string" ? body.title : undefined, true, body.projectId, undefined, body.approvalMode, undefined,
        auth.kind === "session" ? [personKey(auth.session)] : undefined);
      if (!task) return json(res, 500, { error: "couldn't create that task" });
      // Who opened it decides who may answer its cards on a shared workspace.
      if (auth.kind === "session") threadStarters.set(task.threadId, actorKey(auth));
      return json(res, 201, { bot: publicBot(store.bot(bot.id)!), task: wireTask(task, store.bot(bot.id)!.modelSelection) });
    }
    // Regenerate title (#1858): name the thread again from its conversation
    // as it is now. The person asked, so the result replaces any title, but
    // only the one this started from: a rename that lands while the one-shot
    // runs wins, and the late result is dropped.
    m = path.match(/^\/api\/bots\/([\w-]+)\/tasks\/([\w-]+)\/title$/);
    if (m && method === "POST") {
      const current = store.projectBotForTask(m[1], m[2]);
      if (!current) return json(res, 404, { error: "no such task" });
      if (!llmThreadTitlesEnabled(cfg)) return json(res, 409, { error: "generated thread titles are turned off on this server" });
      
      const instance = registry.get(current.modelSelection.instanceId);
      if (!instance?.generateText) return json(res, 409, { error: "this bot's model can't generate a title — rename the thread instead" });
      if (titleRegenerations.has(m[2])) return json(res, 409, { error: "a new title is already being generated for this thread" });
      const excerpt = titleConversationExcerpt(store.messagesTail(m[2], 200).messages);
      if (!excerpt) return json(res, 409, { error: "this thread has no messages to take a title from yet" });
      try {
        assertWithinBudget(cfg, DATA_DIR);
      } catch (error) {
        return json(res, 409, { error: error instanceof Error ? error.message : String(error) });
      }
      const startedFrom = store.taskByThread(m[1], m[2])!.title;
      titleRegenerations.add(m[2]);
      try {
        const title = await generateThreadTitle(instance, excerpt, "conversation");
        if (!title) return json(res, 502, { error: "couldn't generate a title — try again, or rename the thread" });
        const task = store.retitleTask(m[1], m[2], startedFrom, title) ?? store.taskByThread(m[1], m[2]);
        if (!task) return json(res, 404, { error: "no such task" });
        return json(res, 200, { task: wireTask(task, store.bot(m[1])!.modelSelection) });
      } finally {
        titleRegenerations.delete(m[2]);
      }
    }

    // what the user's machine can host: which runtime is installed, whether
    // its daemon is up, and whether the desktop image and container exist
    if (method === "GET" && path === "/api/local-computer") {
      return json(res, 200, await localVmPayload(SHARED_LOCAL_VM_TARGET, auth));
    }
    if (method === "GET" && path === "/api/local-computer/instances") {
      res.setHeader("cache-control", "private, no-store");
      return json(res, 200, await localVmInventoryPayload());
    }
    m = path.match(/^\/api\/local-computer\/(pull|run|start|stop|remove)$/);
    if (m && method === "POST") {
      // Requiring JSON makes these localhost lifecycle mutations non-simple
      // browser requests. A hostile web page cannot submit them with a form,
      // and its cross-origin JSON request is stopped by the browser preflight
      // because this server deliberately emits no CORS permission.
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const action = z.enum(["pull", "run", "start", "stop", "remove"]).parse(m[1]);
      if (localVmFlags.imageBusy || localVmFlags.modeChangeBusy || localVmLifecycleBusy.has(SHARED_LOCAL_VM_TARGET.key)) {
        return json(res, 409, { error: "another Local VM setup action is still running" });
      }
      if (localVmMode(cfg) === "per-bot" && action === "run") {
        return json(res, 409, { error: "Per-bot mode creates each desktop from that bot's Computer panel" });
      }
      if (localVmMode(cfg) === "pool" && action === "run") {
        return json(res, 409, { error: "Pool mode creates its desktops automatically from conversation turns" });
      }
      const vmOwner = localVmLeaseFor(SHARED_LOCAL_VM_TARGET).current(localVmOwnerBusy);
      if (vmOwner && (action === "stop" || action === "remove" || action === "run")) {
        return json(res, 409, { error: "the Local VM is being used by a bot — stop that turn first" });
      }
      // A lease can lapse under a long, quiet turn whose thread still holds
      // the desktop, so stop/remove must also refuse while the thread
      // registry or a setup action pins it — the same guard bot deletion uses.
      if ((action === "stop" || action === "remove") && (localVmActiveThreads.has(SHARED_LOCAL_VM_TARGET.key) || localVmLifecycleBusy.has(SHARED_LOCAL_VM_TARGET.key))) {
        return json(res, 409, { error: localVmActiveThreads.has(SHARED_LOCAL_VM_TARGET.key) ? "the Local VM is being used by a bot — stop that turn first" : "another Local VM setup action is still running" });
      }
      if (action === "pull") localVmFlags.imageBusy = true;
      else localVmLifecycleBusy.add(SHARED_LOCAL_VM_TARGET.key);
      try {
        const status = await containerComputerAction(action, undefined, undefined, SHARED_LOCAL_VM_TARGET);
        if (action === "run" || action === "start") {
          localVmSeen.add(SHARED_LOCAL_VM_TARGET.key);
          localVmIdleFor(SHARED_LOCAL_VM_TARGET).touch();
        }
        if (action === "stop" || action === "remove") localVmIdleFor(SHARED_LOCAL_VM_TARGET).cancel();
        return json(res, 200, {
          ...localVmViewerStatus(status, auth),
          commands: setupCommands(status.runtime, process.platform, SHARED_LOCAL_VM_TARGET),
          idle_timeout_ms: localVmIdleMs(),
          mode: localVmMode(cfg),
          max_instances: localVmMaxInstances(cfg),
        });
      } finally {
        if (action === "pull") localVmFlags.imageBusy = false;
        else localVmLifecycleBusy.delete(SHARED_LOCAL_VM_TARGET.key);
      }
    }
    if (method === "POST" && path === "/api/local-computer/screenshot") {
      localVmIdleFor(SHARED_LOCAL_VM_TARGET).touch();
      res.setHeader("cache-control", "private, no-store");
      return json(res, 200, {
        image: await containerComputerScreenshot(undefined, undefined, SHARED_LOCAL_VM_TARGET),
      });
    }

    m = path.match(/^\/api\/bots\/([\w-]+)\/local-computer$/);
    if (m && method === "GET") {
      const bot = computerPreviewBot(m[1], url);
      if (!bot) return json(res, 404, { error: "no such bot" });
      return json(res, 200, await localVmPayload(localVmTargetForStatus(bot.id, bot.threadId), auth));
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/local-computer\/(run|start|stop|remove)$/);
    if (m && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const action = z.enum(["run", "start", "stop", "remove"]).parse(m[2]);
      const target = localVmTargetForBot(bot.id);
      if (target.key === SHARED_LOCAL_VM_TARGET.key) {
        return json(res, 409, { error: "Shared mode manages this desktop in App Settings → Computers" });
      }
      if (localVmFlags.imageBusy || localVmFlags.modeChangeBusy || localVmLifecycleBusy.has(target.key)) {
        return json(res, 409, { error: "this bot's Local VM setup action is still running" });
      }
      if (action === "run" && localVmProvisionBusy()) {
        return json(res, 409, { error: "another per-bot Local VM is being created — retry after it finishes" });
      }
      const vmOwner = localVmLeaseFor(target).current(localVmOwnerBusy);
      if (vmOwner) return json(res, 409, { error: "this bot is using its Local VM — stop the turn first" });
      // Mirrors the shared-target guard above: the lease alone can miss a
      // long, quiet turn, and a setup action must not be torn down mid-call.
      if ((action === "stop" || action === "remove") && (localVmActiveThreads.has(target.key) || localVmLifecycleBusy.has(target.key))) {
        return json(res, 409, { error: localVmActiveThreads.has(target.key) ? "this bot is using its Local VM — stop the turn first" : "this bot's Local VM setup action is still running" });
      }
      // Fence this target, and the cross-target capacity decision for creates,
      // before the first await so two requests cannot both pass the limit.
      localVmLifecycleBusy.add(target.key);
      if (action === "run") setLocalVmProvisionBusy(true);
      try {
        if (action === "run") {
          const before = await containerComputerStatus(undefined, undefined, target);
          if (!before.runtime) return json(res, 409, { error: before.problem ?? "No container runtime is installed" });
          if (!(await containerComputerExists(before.runtime, target))) {
            const count = await existingPerBotLocalVmCount(before.runtime);
            if (count >= localVmMaxInstances(cfg)) {
              return json(res, 409, {
                error: `The per-bot Local VM limit is ${localVmMaxInstances(cfg)} — delete an unused bot VM or raise the limit in App Settings`,
              });
            }
          }
        }
        const status = await containerComputerAction(action, undefined, undefined, target);
        if (action === "run" || action === "start") {
          localVmSeen.add(target.key);
          localVmIdleFor(target).touch();
        }
        if (action === "stop" || action === "remove") localVmIdleFor(target).cancel();
        return json(res, 200, {
          ...localVmViewerStatus(status, auth),
          commands: setupCommands(status.runtime, process.platform, target),
          idle_timeout_ms: localVmIdleMs(),
          mode: localVmMode(cfg),
          max_instances: localVmMaxInstances(cfg),
        });
      } finally {
        if (action === "run") setLocalVmProvisionBusy(false);
        localVmLifecycleBusy.delete(target.key);
      }
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/local-computer\/screenshot$/);
    if (m && method === "POST") {
      const bot = computerPreviewBot(m[1], url);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (url.searchParams.has("threadId") && await computerPreviewSurface(bot, bot.threadId) !== "vm") {
        return json(res, 409, { error: "This conversation is not using the Local VM" });
      }
      const target = localVmTargetForStatus(bot.id, url.searchParams.has("threadId") ? bot.threadId : undefined);
      localVmIdleFor(target).touch();
      res.setHeader("cache-control", "private, no-store");
      return json(res, 200, {
        image: await containerComputerScreenshot(undefined, undefined, target),
      });
    }
    // The Local VM's live desktop for a phone, granted only to the control
    // lease that holds this bot's computer right now. Two callers:
    //
    // The companion sidecar (a loopback caller) gets the VM's own noVNC
    // address, VNC password included, relays it to a paired phone the owner
    // has allowed computer access, keeps re-checking the lease with
    // `action: "check"`, and cuts the relay when it no longer holds.
    //
    // A phone paired with this server directly (`colonie serve`, no
    // sidecar) never sees that address. It gets this server's own
    // authenticated desktop proxy, bound to its lease: the proxy re-checks
    // the lease and the session every few seconds and closes the socket when
    // either lapses. Reaching here at all took the admin scope, which a
    // chat-only pairing (`colonie pair --client`) does not have, so
    // computer access is the same explicit choice the owner's browser makes.
    m = path.match(/^\/api\/bots\/([\w-]+)\/local-computer\/join$/);
    if (m && method === "POST") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const bot = computerPreviewBot(m[1], url);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const threadId = url.searchParams.has("threadId") ? bot.threadId : undefined;
      if (threadId && await computerPreviewSurface(bot, threadId) !== "vm") {
        return json(res, 409, { error: "This conversation is not using the Local VM" });
      }
      // A bot's human-control hold does not reserve a shared desktop or pool
      // seat. Another bot could drive it while the phone is holding this bot.
      if (localVmMode(cfg) !== "per-bot") {
        return json(res, 409, { error: "Phone control requires a per-bot Local VM. Select per-bot mode in Settings → Computers." });
      }
      const lease = controlLeaseIdSchema.safeParse(url.searchParams.get("controlLeaseId") ?? undefined);
      if (!lease.success) return json(res, 400, { error: "controlLeaseId is required" });
      const controlBot = store.bot(bot.id);
      if (!controlBot || !computerControl.ownsLease(botComputerControlKey(controlBot), lease.data)) {
        return json(res, 409, { error: "Take control of this computer first" });
      }
      const target = localVmTargetForStatus(bot.id, threadId);
      const status = await containerComputerStatus(undefined, undefined, target);
      if (!status.ready || !status.managed || status.container !== "running" || status.network !== "loopback"
        || !status.viewer_url) {
        return json(res, 409, { error: status.problem ?? "The Local VM is not ready" });
      }
      localVmIdleFor(target).touch();
      res.setHeader("cache-control", "private, no-store");
      if (auth.kind === "loopback") return json(res, 200, { joinUrl: status.viewer_url });
      const socket = new URLSearchParams({ botId: bot.id, ...(threadId ? { threadId } : {}), controlLeaseId: lease.data });
      return json(res, 200, {
        socketPath: `api/desktop-viewer/${viewerTargetId(target)}/websockify?${socket}`,
        password: new URLSearchParams(new URL(status.viewer_url).hash.slice(1)).get("password"),
      });
    }

    // The bots' browser engine: install it on this machine (agent-browser +
    // a Chrome for Testing, a one-time download), or ask how that is going.
    // One install at a time; the config frame's browserEngine tells the rest.
    // JSON only, so a form posted from another local page cannot start it.
    if (method === "POST" && path === "/api/browser-engine/install") {
      const mediaType = String(req.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
      if (mediaType !== "application/json") {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      if (!browserEngineInstall()) {
        const status = browserEngineStatus();
        if (status.kind === "unavailable" && !status.installable) return json(res, 409, { error: status.reason });
        setBrowserEngineInstallError(null);
        setBrowserEngineInstall((async () => {
          const binary = resolveAgentBrowserBinary() ?? await installAgentBrowserBinary({ log: (line) => console.log(line) });
          await ensureChrome(binary, { log: (line) => console.log(line) });
        })().then(
          () => { setBrowserEngineInstallError(null); },
          (error: unknown) => { setBrowserEngineInstallError(error instanceof Error ? error.message : String(error)); },
        ).finally(() => {
          setBrowserEngineInstall(null);
          broadcast({ kind: "config", ...configStatus() });
        }));
        broadcast({ kind: "config", ...configStatus() });
      }
      return json(res, 202, { installing: true });
    }


    // ── app config (API keys — never echoed back, booleans only) ──

    // Desktop credential cards never send the credential through this route.
    // Electron saves it through the OS-backed store first; these actions only
    // verify configured state, update card metadata, and resume the turn.
    m = path.match(/^\/api\/bots\/([\w-]+)\/secret-cards\/([\w-]+)\/(provided|resume|dismiss)$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      const threadId = String(body.threadId ?? "");
      const message = secretMessage(m[1], threadId, m[2]);
      if (!message?.secret) return json(res, 404, { error: "no such credential request" });
      if (m[3] === "provided") {
        if (message.secret.dismissed) return json(res, 409, { error: "this credential request was dismissed" });
        if (message.secret.superseded) return json(res, 409, { error: "this credential request was superseded by a newer one" });
        if (!credentialIsConfigured(cfg, message.secret.target)) {
          return json(res, 409, { error: `${message.secret.label} was not saved yet` });
        }
        if (!resumeSecretCard(m[1], threadId, message.id, "provided")) {
          return json(res, 409, { error: "this credential request is no longer available" });
        }
        const state = currentSecretState(m[1], threadId, message.id);
        if (!state) return json(res, 409, { error: "this credential request is no longer available" });
        return json(res, 200, state);
      }
      if (m[3] === "resume") {
        if (message.secret.superseded) return json(res, 409, { error: "this credential request was superseded by a newer one" });
        const outcome = credentialResumeOutcome(message.secret);
        if (!outcome) {
          return json(res, 409, { error: "this credential request is not ready to resume" });
        }
        if (outcome === "provided" && !credentialIsConfigured(cfg, message.secret.target)) {
          return json(res, 409, { error: `${message.secret.label} is no longer configured` });
        }
        if (!resumeSecretCard(m[1], threadId, message.id, outcome)) {
          return json(res, 409, { error: "this credential request is no longer available" });
        }
        const state = currentSecretState(m[1], threadId, message.id);
        if (!state) return json(res, 409, { error: "this credential request is no longer available" });
        return json(res, 200, { resumed: state.resumed });
      }
      if (message.secret.superseded) return json(res, 409, { error: "this credential request was superseded by a newer one" });
      if (!message.secret.provided && !resumeSecretCard(m[1], threadId, message.id, "dismissed")) {
        return json(res, 409, { error: "this credential request is no longer available" });
      }
      const state = currentSecretState(m[1], threadId, message.id);
      if (!state) return json(res, 409, { error: "this credential request is no longer available" });
      return json(res, 200, { dismissed: true, resumed: state.resumed });
    }

    // Inline connection cards are bound to both the bot and the exact task
    // or room thread that created them. The browser auth URL is returned
    // only to this local UI and is never stored in the transcript.
    m = path.match(/^\/api\/bots\/([\w-]+)\/connector-cards\/([\w-]+)\/(authorize|status|resume|dismiss)$/);
    if (m) {
      const body = method === "POST" ? await readBody(req) : {};
      const threadId = String(method === "GET" ? url.searchParams.get("threadId") ?? "" : body.threadId ?? "");
      const message = connectorMessage(m[1], threadId, m[2]);
      if (!message?.connector) return json(res, 404, { error: "no such connection request" });
      const connector = message.connector;
      if (m[3] === "authorize" && method === "POST") {
        store.patchMessage(threadId, message.id, {
          connector: { ...connector, status: "authorizing", error: undefined, dismissed: false },
        });
        try {
          return json(res, 200, await composio.authorizeService(cfg, connector.slug, connector.alias));
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          store.patchMessage(threadId, message.id, {
            connector: { ...connector, status: "failed", error: detail.slice(0, 180) },
          });
          throw error;
        }
      }
      if (m[3] === "status" && method === "GET") {
        const service = (await composio.connectionStatus(cfg, [connector.slug]))[connector.slug];
        // A different active account must never complete a second-account card.
        // Missing alias metadata stays pending rather than guessing from the
        // toolkit-wide status (including scoped keys without account reads).
        const account = connector.alias
          ? service?.accounts?.find((item) => item.alias?.trim().toLowerCase() === connector.alias!.toLowerCase())
          : undefined;
        const state = connector.alias ? {
          connected: /^active$/i.test(account?.status ?? ""),
          pending: /^(initiated|initializing|pending)$/i.test(account?.status ?? ""),
          status: account?.status ?? "not_connected",
        } : service;
        const failed = /failed|expired|revoked|error/i.test(state?.status ?? "");
        const next = {
          ...connector,
          status: state?.connected ? ("connected" as const) : failed ? ("failed" as const) : ("authorizing" as const),
          error: failed ? `Connection ${state?.status ?? "failed"}` : undefined,
        };
        store.patchMessage(threadId, message.id, { connector: next });
        if (state?.connected) maybeResumeConnectors(m[1], threadId, connector.resumeKey);
        return json(res, 200, { connected: Boolean(state?.connected), pending: Boolean(state?.pending), status: state?.status });
      }
      if (m[3] === "resume" && method === "POST") {
        const resumed = maybeResumeConnectors(m[1], threadId, connector.resumeKey);
        return resumed
          ? json(res, 200, { resumed: true })
          : json(res, 409, { error: "finish connecting every requested app first" });
      }
      if (m[3] === "dismiss" && method === "POST") {
        store.patchMessage(threadId, message.id, { connector: { ...connector, dismissed: true } });
        return json(res, 200, { dismissed: true });
      }
      return json(res, 405, { error: "method not allowed" });
    }

    // Who is driving this bot's computer. GET is the panel's initial read;
    // POST take/release/dismiss-help are the person's three moves. The bot
    // has no verb here at all — its only voice is the internal help plea.
    m = path.match(/^\/api\/bots\/([\w-]+)\/computer\/control$/);
    if (m) {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (method === "GET") return json(res, 200, botComputerControlSnapshot(bot.id));
      if (method === "POST") {
        // JSON-only for the same anti-form-POST reason as every other
        // computer mutation below.
        if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
          return json(res, 415, { error: "content-type must be application/json" });
        }
        const body = await readBody(req);
        const action = String(body.action ?? "");
        const currentBot = store.bot(bot.id);
        if (!currentBot) return json(res, 404, { error: "no such bot" });
        const controlKey = botComputerControlKey(currentBot);
        const leaseResult =
          body.controlLeaseId === undefined
            ? null
            : controlLeaseIdSchema.safeParse(body.controlLeaseId);
        if (leaseResult && !leaseResult.success) {
          return json(res, 400, { error: "controlLeaseId is invalid" });
        }
        const controlLeaseId = leaseResult?.data;
        if (action === "take" && controlLeaseId) {
          const result = computerControl.acquireLease(controlKey, controlLeaseId);
          return json(res, 200, {
            ...result.snapshot,
            owned: result.owned,
            acquired: result.acquired,
          });
        }
        if (action === "release" && controlLeaseId) {
          const result = computerControl.releaseLease(controlKey, controlLeaseId);
          return json(res, 200, { ...result.snapshot, released: result.released });
        }
        // Read-only: does this lease still hold the wheel? The companion
        // sidecar asks this while it relays a phone's live Local VM desktop,
        // and cuts the relay the moment the answer is no.
        if (action === "check" && controlLeaseId) {
          return json(res, 200, { ...computerControl.snapshot(controlKey), owned: computerControl.ownsLease(controlKey, controlLeaseId) });
        }
        if (action === "take") return json(res, 200, computerControl.take(controlKey));
        if (action === "release") return json(res, 200, computerControl.release(controlKey));
        if (action === "dismiss-help") return json(res, 200, computerControl.dismissHelp(controlKey));
        return json(res, 400, { error: "action must be take, release, check, or dismiss-help" });
      }
      return json(res, 405, { error: "method not allowed" });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/computer\/viewer-close$/);
    if (m && method === "POST") {
      const bot = computerPreviewBot(m[1], url);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      // A directly paired phone's Local VM desktop runs through this server's
      // own proxy under its lease on this bot; hand-back closes it here, ahead
      // of the lease re-check. The session's other viewers are left alone.
      const closedViewers = auth.kind === "session" ? desktopViewer.closeForOwner(auth.session.id, bot.id) : 0;
      return json(res, 200, { closed: closedViewers > 0 });
    }
    return json(res, 404, { error: `no route: ${method} ${path}` });
  } catch (e) {
    const status = (e as any)?.status ?? 500;
    const candidateCode = (e as { code?: unknown })?.code;
    const code = typeof candidateCode === "string" && ["guarded_busy", "guarded_branch", "guarded_permissions", "guarded_request_changed", "guarded_request_untracked", "outside_workspace"].includes(candidateCode)
      ? candidateCode : undefined;
    return json(res, status, { error: e instanceof Error ? e.message : String(e), ...(code ? { code } : {}) });
  } finally {
    releaseWorkspaceRequest?.();
  }
};
  return handleRequest;
}
