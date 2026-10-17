import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { Store, UNTITLED_TASK } from "./store.ts";
import { RoutineManager } from "./routines.ts";
import { createTeamBackup, importTeamBackup } from "./team-backup.ts";
import { parseTeamBackup } from "../shared/team-backup.ts";
import { soulFile, soulHash } from "./bot-folder.ts";
import { appendMemoryLog, readMemoryFile, readMemoryLog, readMemoryTopic, searchMemoryFiles, updateMemory, workspaceDir, writeMemoryTopic } from "./workspace.ts";

const selection = () => ({ instanceId: "fixture", model: "fixture-model" });

type FixtureBots = { chief: { id: string }; scout: { id: string } };

/** Rooms are retired and the store cannot create them: the fixture seeds
 * groups.json the way an older build saved it, then reloads. */
function fixture(options: { secondRoomTask?: Record<string, unknown>; legacyRooms?: (bots: FixtureBots) => Record<string, unknown>[] } = {}) {
  let store = new Store(selection);
  const chief = store.createBot({ name: "Mira", section: "Engineering", description: "Full instructions\n".repeat(400) }, { seedMessages: false });
  store.setSoul(chief.id, "  Cite sources.\nRespect the user's current request. 🐭\n");
  const scout = store.createBot({ name: "Scout", section: "Engineering", mascotBody: "circle" }, { seedMessages: false });
  const otherChief = store.createBot({ name: "Ava", section: "Operations" }, { seedMessages: false });
  const archived = store.createBot({ name: "Archived" }, { seedMessages: false });
  store.patchBot(archived.id, { hidden: true });
  store.patchBot(chief.id, { chiefOfStaff: true, autoApprove: true, approvalMode: "full", alwaysAllow: ["Bash"], cwd: "/private/old-workspace", composio: true,
    playbooks: [{ key: "research", name: "Research", summary: "Find evidence", triggers: ["research"], instructions: "Cite sources" }] });
  store.setChiefOfStaff(otherChief.id);
  const root = store.appendMessage(chief.threadId, { role: "user", kind: "text", text: "Original question", at: 100 });
  const answer = store.appendMessage(chief.threadId, { role: "bot", kind: "text", text: "Original answer", at: 101 });
  store.branchMessage(chief.threadId, root.id, "Edited question");
  store.setActiveLeaf(chief.threadId, answer.id);
  store.renameTask(chief.id, chief.threadId, "First conversation");
  // created first: tasks are newest-first and the tests below read the
  // transcript of tasks[0], which must stay the conversation with messages
  const strangers = store.createTask(chief.id, "Opened by a deleted bot", false, undefined, { botId: "gone-bot", name: "Gone", at: 98 })!;
  store.setTaskClosedBy(chief.id, strangers.threadId, { botId: "gone-bot", name: "Gone", at: 102 });
  const active = store.createTask(chief.id, "Second conversation")!;
  store.setTaskOpenedBy(chief.id, active.threadId, { botId: scout.id, name: scout.name, delegationId: "do-not-resume-delegation", kind: "pair", at: 99 });
  store.setTaskClosedBy(chief.id, active.threadId, { botId: scout.id, name: scout.name, at: 103 });
  store.appendMessage(active.threadId, { role: "user", kind: "text", text: "Current question", queued: true, queueId: "do-not-replay" });
  store.appendMessage(active.threadId, { role: "bot", kind: "options", card: {
    title: "Permission request", subtitle: "Old approval", options: ["Allow"], requestId: "do-not-resume", allowKey: "Bash",
  } });
  store.appendMessage(active.threadId, { role: "user", kind: "text", text: "An image", attachments: [{ kind: "image", path: "/private/image.png", mime: "image/png" }] });
  const roomId = randomUUID();
  const roomThreadId = randomUUID();
  writeFileSync(join(DATA_DIR, "groups.json"), JSON.stringify([{
    id: roomId, threadId: roomThreadId, name: "Project room", memberIds: [chief.id, scout.id],
    defaultResponder: { kind: "member", botId: chief.id }, bulletin: "Build carefully", unread: false,
    createdAt: 1, section: "Engineering", setupCompletedAt: 1, setupSkippedAt: null,
    tasks: [
      { threadId: randomUUID(), title: "Second room task", createdAt: 2, updatedAt: 2, ...options.secondRoomTask },
      { threadId: roomThreadId, title: UNTITLED_TASK, createdAt: 1, updatedAt: 1 },
    ],
  }, ...(options.legacyRooms?.({ chief, scout }) ?? [])], null, 2), { mode: 0o600 });
  store.appendMessage(roomThreadId, { role: "bot", kind: "text", text: "Room answer", from: { botId: scout.id, name: scout.name, color: scout.color }, peerPost: { unattended: true } });
  store = new Store(selection);
  const group = store.group(roomId)!;
  // Room goals can no longer be created; a stored one still loads, paused.
  const routinesFile = join(DATA_DIR, "routines.json");
  writeFileSync(routinesFile, JSON.stringify({ routines: [{
    id: "stored-room-goal", name: "Standup", prompt: "Discuss progress", target: "room-goal", groupId: group.id, botId: chief.id,
    runOn: "maus", enabled: true, schedule: { type: "interval", everyMinutes: 30, anchorAt: 0 }, durationMinutes: 30,
    nextRunAt: null, createdAt: 1, updatedAt: 1,
  }], runs: [] }));
  const routines = new RoutineManager({
    file: routinesFile,
    botState: (id) => store.bot(id) ? "ready" : "missing",
    createTask: (id, title) => store.createTask(id, title),
    startTurn: async () => { throw new Error("Import must never run a bot"); },
  });
  routines.create({ name: "Daily", prompt: "Report progress", botId: chief.id, enabled: true, schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] } });
  return { store, routines, chief: store.bot(chief.id)!, scout: store.bot(scout.id)!, otherChief: store.bot(otherChief.id)!, archived: store.bot(archived.id)!, group };
}

describe("additive portable team backups", () => {
  beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

  it("carries tool restrictions through backup and import without restoring execution grants", () => {
    const { store, routines, chief, scout } = fixture();
    const scope = { allow: ["native:read", "mcp:notes:read"], deny: ["mcp:notes:write"] };
    store.patchBot(chief.id, { toolScope: scope } as never);
    store.patchBot(scout.id, { toolScope: { allow: [] } } as never);
    const backup = createTeamBackup(store, routines.listRoutines(), "Selected tools");
    expect(backup.bots.find((bot) => bot.key === chief.id)).toHaveProperty("toolScope", scope);
    const restored = importTeamBackup(store, routines, backup, selection());
    expect(restored.bots.find((bot) => bot.name === "Mira 2")).toMatchObject({ toolScope: scope, computer: "off", composio: false, approvalMode: "ask", connectorTools: {} });
    expect(restored.bots.find((bot) => bot.name === "Scout 2")).toHaveProperty("toolScope", { allow: [] });
    const invalid = structuredClone(backup) as unknown as { bots: Array<{ toolScope: unknown }> };
    invalid.bots[0].toolScope = { allow: null };
    expect(() => parseTeamBackup(invalid)).toThrow();
  });

  it("carries each bot's memory, topic notes and daily logs, scrubbed on the way out and private on the way in", () => {
    const { store, routines, chief, scout } = fixture();
    const now = new Date(2026, 8, 10, 12);
    updateMemory(chief.id, { action: "append", text: "The user's name is Ada" }, { source: 'chat "Setup"', now });
    writeMemoryTopic(chief.id, "deploys.md", "railway up from main\n");
    appendMemoryLog(chief.id, "shipped 0.1.70", { source: 'chat "Deploy"', now });
    // a topic the bot's own file tools wrote never met the server's scrub
    const key = `sk-ant-api03-${"k".repeat(40)}`;
    writeFileSync(join(workspaceDir(chief.id), "memory", "keys.md"), `anthropic: ${key}\n`);

    const backup = createTeamBackup(store, routines.listRoutines(), "With memory");
    const exported = backup.bots.find((bot) => bot.key === chief.id)!.memory!;
    expect(exported.file).toBe('- 2026-09-10 · from chat "Setup" · The user\'s name is Ada\n');
    expect(exported.topics.map((topic) => topic.name)).toEqual(["deploys.md", "keys.md"]);
    expect(exported.topics[1].text).not.toContain(key);
    expect(exported.topics[1].text).toContain("anthropic: «redacted");
    expect(exported.logs).toEqual([{ name: "2026-09-10.md", text: '- 12:00 · from chat "Deploy" · shipped 0.1.70\n' }]);
    // a bot that never remembered anything travels as before
    expect(backup.bots.find((bot) => bot.key === scout.id)!.memory).toBeUndefined();
    expect(JSON.stringify(backup)).not.toContain(key);

    const result = importTeamBackup(store, routines, JSON.parse(JSON.stringify(backup)), selection());
    const imported = result.bots.find((bot) => bot.name === "Mira 2")!;
    expect(readMemoryFile(imported.id).text).toBe(exported.file);
    expect(readMemoryTopic(imported.id, "deploys.md")).toBe("railway up from main\n");
    expect(readMemoryTopic(imported.id, "keys.md")).toBe(exported.topics[1].text);
    expect(readMemoryLog(imported.id, "2026-09-10.md")).toBe(exported.logs[0].text);
    expect(readFileSync(soulFile(imported.id), "utf8")).toBe(chief.soul);
    if (process.platform !== "win32") {
      const dir = workspaceDir(imported.id);
      expect(statSync(join(dir, "memory")).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, "memory", "log")).mode & 0o777).toBe(0o700);
      for (const file of ["MEMORY.md", "memory/deploys.md", "memory/keys.md", "memory/log/2026-09-10.md"]) {
        expect(statSync(join(dir, file)).mode & 0o777, file).toBe(0o600);
      }
    }
    // the imported copy is searchable at once, and the original untouched
    expect(searchMemoryFiles(imported.id, "railway").map((hit) => hit.file)).toEqual(["memory/deploys.md"]);
    expect(readMemoryFile(chief.id).text).toBe(exported.file);
    const noMemory = result.bots.find((bot) => bot.name === "Scout 2")!;
    expect(readMemoryFile(noMemory.id).text).toBe("");
  });

  it("round-trips all bots, sections, Chiefs, tasks and branches without changing originals", () => {
    const { store, routines, chief, scout, otherChief, archived } = fixture();
    const backup = createTeamBackup(store, routines.listRoutines(), "My team");
    const originalBots = structuredClone(store.bots);
    const originalGroups = structuredClone(store.groups);
    const groupsFile = readFileSync(join(DATA_DIR, "groups.json"), "utf8");
    const originalRoutines = routines.listRoutines();
    const result = importTeamBackup(store, routines, JSON.parse(JSON.stringify(backup)), selection());
    // Export and import read groups.json and never rewrite it.
    expect(readFileSync(join(DATA_DIR, "groups.json"), "utf8")).toBe(groupsFile);
    expect(result.bots).toHaveLength(4);
    // Rooms are retired: the room and its room routine stay in the file,
    // are not recreated, and each is named in a warning.
    expect(result).not.toHaveProperty("groups");
    expect(store.groups).toEqual(originalGroups);
    expect(result.warnings).toEqual([
      "Room “Project room” was not imported. Rooms are no longer supported; its conversation stays in the backup file.",
      "Routine “Standup” was not imported because it runs in a room.",
    ]);
    for (const bot of originalBots) expect(store.bot(bot.id)).toEqual(bot);
    for (const room of originalGroups) expect(store.group(room.id)).toEqual(room);
    for (const routine of originalRoutines) expect(routines.listRoutines().find((r) => r.id === routine.id)).toEqual(routine);
    const importedChief = result.bots.find((bot) => bot.name === "Mira 2")!;
    const importedScout = result.bots.find((bot) => bot.name === "Scout 2")!;
    expect(importedChief.soul).toBe(chief.soul);
    expect(importedChief.soulHash).toBe(soulHash(chief.soul!));
    expect(readFileSync(soulFile(importedChief.id), "utf8")).toBe(chief.soul);
    expect(importedChief).toMatchObject({ section: "Engineering 2", chiefOfStaff: true, description: chief.description, computer: "off", composio: false, browser: false, approvalMode: "ask", autoApprove: false, resumeCursors: {}, playbooks: chief.playbooks });
    expect(result.bots.find((bot) => bot.name === "Ava 2")).toMatchObject({ section: "Operations 2", chiefOfStaff: true });
    expect(result.bots.find((bot) => bot.name === "Archived 2")).toMatchObject({ hidden: true });
    expect(importedChief).not.toHaveProperty("cwd");
    expect(importedChief).not.toHaveProperty("alwaysAllow");
    // Imported threads follow the imported bot's model.
    expect(importedChief.tasks?.every((task) => task.activity === "idle" && task.busy === false
      && task.unread === false && task.modelSelection === undefined
      && store.projectBotForTask(importedChief.id, task.threadId)?.modelSelection.instanceId === selection().instanceId)).toBe(true);
    expect(store.bot(otherChief.id)?.chiefOfStaff).toBe(true);
    expect(store.bot(archived.id)?.hidden).toBe(true);
    expect(importedScout.mascotBody).toBe(scout.mascotBody);
    expect(backup.groups[0]).toMatchObject({ name: "Project room", memberIds: [chief.id, scout.id] });
    expect(result.routines.map((routine) => routine.name)).toEqual(["Daily"]);
    expect(result.routines.every((routine) => !routine.enabled && routine.nextRunAt === null && routine.botId === importedChief.id && routine.groupId === undefined)).toBe(true);
    // who opened a thread travels with it, remapped like a message's `from`;
    // the handoff id stays behind with the ledger it belongs to
    expect(importedChief.tasks!.find((task) => task.title === "Second conversation")!.openedBy)
      .toEqual({ botId: importedScout.id, name: scout.name, kind: "pair", at: 99 });
    expect(importedChief.tasks!.find((task) => task.title === "Opened by a deleted bot")).not.toHaveProperty("openedBy");
    expect(importedChief.tasks!.find((task) => task.title === "First conversation")).not.toHaveProperty("openedBy");
    // a thread the opener closed stays closed after import, closer remapped the same way
    expect(importedChief.tasks!.find((task) => task.title === "Second conversation")!.closedBy)
      .toEqual({ botId: importedScout.id, name: scout.name, at: 103 });
    expect(importedChief.tasks!.find((task) => task.title === "Opened by a deleted bot")).not.toHaveProperty("closedBy");
    expect(importedChief.tasks!.find((task) => task.title === "First conversation")).not.toHaveProperty("closedBy");
    const firstTask = importedChief.tasks!.find((task) => task.title === "First conversation")!;
    expect(store.messagesFor(firstTask.threadId).map((message) => message.text)).toEqual(["Original question", "Original answer", "Edited question"]);
    expect(store.activePath(firstTask.threadId).map((message) => message.text)).toEqual(["Original question", "Original answer"]);
    const importedHistory = store.messagesFor(importedChief.threadId);
    expect(importedHistory.every((message) => message.kind === "text" && !message.queued && !message.card)).toBe(true);
    expect(importedHistory[1].text).toContain("Permission request");
    expect(importedHistory[2].text).toContain("file not included");
    expect(JSON.stringify(backup)).not.toMatch(/do-not-replay|do-not-resume|\/private\/image|\/private\/old-workspace|alwaysAllow|autoApprove|modelSelection|delegationId/);
    const reloaded = new Store(selection);
    expect(reloaded.bot(importedChief.id)?.soul).toBe(chief.soul);
    expect(reloaded.activePath(firstTask.threadId)).toEqual(store.activePath(firstTask.threadId));
    expect(reloaded.bot(importedChief.id)?.tasks).toEqual(importedChief.tasks);
    expect(reloaded.messagesFor(chief.threadId)).toEqual(store.messagesFor(chief.threadId));
    // Re-import makes another independent set, not updates to either set.
    const second = importTeamBackup(store, routines, backup, selection());
    expect(second.bots.find((bot) => bot.name === "Mira 3")).toMatchObject({ section: "Engineering 3", chiefOfStaff: true });
    expect(store.bot(importedChief.id)).toEqual(importedChief);
  });

  it("carries connector grants in the private backup but lands imported bots grant-less", () => {
    const { store, routines, chief } = fixture();
    store.patchBot(chief.id, { connectorTools: { gmail: { tools: ["GMAIL_SEND_EMAIL", "GMAIL_SEND_EMAIL"] } } });
    const backup = createTeamBackup(store, routines.listRoutines(), "Granted team");
    expect(backup.bots.find((bot) => bot.key === chief.id)?.connectorTools).toEqual({
      gmail: { tools: ["GMAIL_SEND_EMAIL"] },
    });
    const result = importTeamBackup(store, routines, JSON.parse(JSON.stringify(backup)), selection());
    const imported = result.bots.find((bot) => bot.name === "Mira 2")!;
    expect(imported.composio).toBe(false);
    expect(imported.connectorTools).toEqual({});
    // the backup format itself rejects grant shapes the store would refuse
    const tampered = JSON.parse(JSON.stringify(backup)) as { bots: { key: string; connectorTools: unknown }[] };
    tampered.bots[0].connectorTools = { gmail: { tools: [] } };
    expect(() => parseTeamBackup(tampered)).toThrow();
  });

  it("keeps first-message title markers armed-once through backup and restore", () => {
    // rows whose first message already named them, one per record kind
    const { store, routines, chief, group } = fixture({ secondRoomTask: { title: "Plan the launch review", titleFromFirstMessage: true } });
    const titled = store.createTask(chief.id, undefined, false)!.threadId;
    store.titleTaskFromFirstMessage(chief.id, "Audit the payroll export", titled);
    const channelTask = group.tasks!.find((task) => task.title === "Plan the launch review")!.threadId;
    const backup = createTeamBackup(store, routines.listRoutines(), "Markers");
    expect(backup.bots.find((bot) => bot.name === "Mira")!.tasks.find((task) => task.key === titled)!.titleFromFirstMessage).toBe(true);
    expect(backup.groups[0].tasks.find((task) => task.key === channelTask)!.titleFromFirstMessage).toBe(true);

    const result = importTeamBackup(store, routines, JSON.parse(JSON.stringify(backup)), selection());
    const restoredBot = result.bots.find((bot) => bot.name === "Mira 2")!;
    const restored = restoredBot.tasks!.find((task) => task.title === "Audit the payroll export")!;
    expect(restored.titleFromFirstMessage).toBe(true);
    // the marker still does its job on the restored row: renaming back to
    // the sentinel cannot re-arm generated titling for a later message
    store.renameTask(restoredBot.id, restored.threadId, UNTITLED_TASK);
    expect(store.titleTaskFromFirstMessage(restoredBot.id, "A later message", restored.threadId)).toBeNull();
    // the room's marker stays in the file; the room itself is skipped
    expect(store.groups).toHaveLength(1);
    // rows the marker never armed — a backup from before the feature —
    // restore exactly as they left, with no marker invented for them
    expect(restoredBot.tasks!.find((task) => task.title === "First conversation")).not.toHaveProperty("titleFromFirstMessage");
  });

  it("exports a room's longer turn limit and skips the room on restore", () => {
    const dmId = randomUUID();
    const { store, routines, group } = fixture({
      secondRoomTask: { turnTimeoutMinutes: 30 },
      legacyRooms: ({ chief, scout }) => [{
        id: dmId, threadId: randomUUID(), name: "Direct", memberIds: [chief.id, scout.id], dm: true,
        defaultResponder: { kind: "mentions" }, bulletin: "", unread: false, createdAt: 3, turnTimeoutMinutes: 45,
      }],
    });
    const dm = store.group(dmId)!;
    const threadId = group.tasks!.find((task) => task.title === "Second room task")!.threadId;

    const backup = createTeamBackup(store, routines.listRoutines(), "Limits");
    const roomTask = backup.groups.find((candidate) => candidate.key === group.id)!.tasks.find((task) => task.key === threadId)!;
    expect(roomTask.turnTimeoutMinutes).toBe(30);
    expect(backup.groups.find((candidate) => candidate.key === dm.id)!.tasks[0].turnTimeoutMinutes).toBe(45);
    expect(backup.bots.every((bot) => bot.tasks.every((task) => task.turnTimeoutMinutes === undefined))).toBe(true);

    const groupsBefore = structuredClone(store.groups);
    const result = importTeamBackup(store, routines, JSON.parse(JSON.stringify(backup)), selection());
    expect(store.groups).toEqual(groupsBefore);
    expect(result.warnings.filter((warning) => warning.startsWith("Room "))).toHaveLength(2);
    expect(result.warnings.some((warning) => warning.includes("“Direct”"))).toBe(true);
  });

  it.each(["unknown-version", "duplicate-bot", "cycle", "dangling-room", "dangling-task", "duplicate-chief", "oversized-soul"])("rejects %s before any writes", (corruption) => {
    const { store, routines } = fixture();
    const backup = createTeamBackup(store, routines.listRoutines(), "My team");
    const before = readFileSync(join(DATA_DIR, "bots.json"), "utf8");
    const groupsBefore = readFileSync(join(DATA_DIR, "groups.json"), "utf8");
    const source = backup.bots.find((bot) => bot.name === "Mira")!;
    if (corruption === "unknown-version") Object.assign(backup, { version: 2 });
    if (corruption === "duplicate-bot") backup.bots.push(source);
    if (corruption === "cycle") source.tasks[0].messages[0].parentId = source.tasks[0].messages[0].id;
    if (corruption === "dangling-room") backup.groups[0].memberIds.push("missing");
    if (corruption === "dangling-task") source.activeTask = "missing";
    if (corruption === "duplicate-chief") backup.bots.find((bot) => bot.name === "Scout")!.chiefOfStaff = true;
    if (corruption === "oversized-soul") source.soul = "🐭".repeat(6_001);
    expect(() => importTeamBackup(store, routines, backup, selection())).toThrow("Invalid backup");
    expect(readFileSync(join(DATA_DIR, "bots.json"), "utf8")).toBe(before);
    expect(readFileSync(join(DATA_DIR, "groups.json"), "utf8")).toBe(groupsBefore);
  });

  it("accepts legacy backups without soul and enforces its UTF-8 byte cap", () => {
    const { store, routines } = fixture();
    const backup = createTeamBackup(store, routines.listRoutines(), "Legacy team");
    for (const bot of backup.bots) delete bot.soul;
    expect(importTeamBackup(store, routines, backup, selection()).bots.every((bot) => bot.soul === "")).toBe(true);
    backup.bots[0].soul = "🐭".repeat(6_000);
    expect(parseTeamBackup(backup).bots[0].soul).toBe(backup.bots[0].soul);
    backup.bots[0].soul += "!";
    expect(() => parseTeamBackup(backup)).toThrow("24000 bytes");
  });

  it("strips injected permissions, IDs and live actions from untrusted files", () => {
    const { store, routines, chief } = fixture();
    const backup = createTeamBackup(store, routines.listRoutines(), "My team");
    const source = backup.bots.find((bot) => bot.name === "Mira")!;
    Object.assign(source, { id: chief.id, threadId: chief.threadId, cwd: "/tmp", composio: true, approvalMode: "full", autoApprove: true, browser: true, computer: "local", resumeCursors: { fixture: "secret-session" } });
    Object.assign(source.tasks[0].messages[0], { kind: "options", queued: true, card: { requestId: "live-approval" }, attachments: [{ path: "/etc/passwd" }] });
    const imported = importTeamBackup(store, routines, backup, selection()).bots.find((bot) => bot.name === "Mira 2")!;
    expect(imported.id).not.toBe(chief.id);
    expect(imported.threadId).not.toBe(chief.threadId);
    expect(imported.approvalMode).toBe("ask");
    expect(JSON.stringify(parseTeamBackup(backup))).not.toMatch(/live-approval|secret-session|\/etc\/passwd|approvalMode/);
  });

  it("rolls back fresh bots and transcripts after a late failure", () => {
    const { store, routines } = fixture();
    const beforeSections = [...store.sections];
    const backup = createTeamBackup(store, routines.listRoutines(), "My team");
    const before = createTeamBackup(store, routines.listRoutines(), "My team");
    const write = vi.spyOn(routines, "create").mockImplementationOnce(() => { throw new Error("fixture disk failure"); });
    expect(() => importTeamBackup(store, routines, backup, selection())).toThrow("fixture disk failure");
    write.mockRestore();
    const after = createTeamBackup(new Store(selection), routines.listRoutines(), "My team");
    expect({ ...after, exportedAt: 0 }).toEqual({ ...before, exportedAt: 0 });
    expect(new Store(selection).sections).toEqual(beforeSections);
  });

  it("refuses to populate a thread that already has history", () => {
    const { store, chief } = fixture();
    const before = structuredClone(store.messagesFor(chief.threadId));
    expect(() => store.importTranscript(chief.threadId, [], null)).toThrow("existing conversation");
    expect(store.messagesFor(chief.threadId)).toEqual(before);
  });

  it("also rolls back a creation that throws before returning its new record", () => {
    const { store, routines } = fixture();
    const beforeSections = [...store.sections];
    const backup = createTeamBackup(store, routines.listRoutines(), "My team");
    const before = structuredClone(store.bots);
    const create = store.createBot.bind(store);
    const fail = vi.spyOn(store, "createBot").mockImplementationOnce((...args) => {
      create(...args);
      throw new Error("creation failed before returning");
    });
    expect(() => importTeamBackup(store, routines, backup, selection())).toThrow("creation failed");
    fail.mockRestore();
    expect(store.bots).toEqual(before);
    expect(new Store(selection).bots.map((bot) => bot.id)).toEqual(before.map((bot) => bot.id));
    expect(new Store(selection).sections).toEqual(beforeSections);
  });

  it("keeps case-distinct sections and their Chiefs separate", () => {
    const { store, routines } = fixture();
    const second = store.createBot({ name: "Another chief", section: "engineering" }, { seedMessages: false });
    store.setChiefOfStaff(second.id);
    const imported = importTeamBackup(store, routines, createTeamBackup(store, routines.listRoutines(), "My team"), selection());
    const chief = imported.bots.find((bot) => bot.name === "Mira 2")!;
    const other = imported.bots.find((bot) => bot.name === "Another chief 2")!;
    expect(chief.chiefOfStaff).toBe(true);
    expect(other.chiefOfStaff).toBe(true);
    expect(chief.section?.toLowerCase()).not.toBe(other.section?.toLowerCase());
    const reloaded = new Store(selection);
    expect(reloaded.bot(chief.id)?.chiefOfStaff).toBe(true);
    expect(reloaded.bot(other.id)?.chiefOfStaff).toBe(true);
  });

  it("backs up room history even when old deletions left dangling memberships and routines, and skips it on restore", () => {
    const dmId = randomUUID();
    const { store, routines, chief, scout, group } = fixture({
      legacyRooms: ({ chief, scout }) => [{
        id: dmId, threadId: randomUUID(), name: "Old direct message", memberIds: [chief.id, scout.id], dm: true,
        defaultResponder: { kind: "mentions" }, bulletin: "", unread: false, createdAt: 3,
      }],
    });
    const dm = store.group(dmId)!;
    store.appendMessage(dm.threadId, { role: "bot", kind: "text", text: "Keep this old reply", from: { botId: chief.id, name: chief.name, color: chief.color } });
    // Deleting a bot leaves stored rooms exactly as saved.
    store.deleteBot(chief.id);
    const backup = createTeamBackup(store, routines.listRoutines(), "My team");
    expect(backup.warnings).toHaveLength(4);
    expect(backup.routines).toEqual([]);
    expect(backup.groups.find((room) => room.key === group.id)).toMatchObject({ memberIds: [scout.id], defaultResponder: { kind: "mentions" } });
    expect(backup.groups.find((room) => room.key === dm.id)?.dm).toBe(false);
    expect(backup.groups.find((room) => room.key === dm.id)?.tasks[0].messages[0]).toMatchObject({ text: "Keep this old reply" });
    const groupCount = store.groups.length;
    const restored = importTeamBackup(store, routines, backup, selection());
    expect(store.groups).toHaveLength(groupCount);
    expect(restored.warnings).toContain("Room “Old direct message” was not imported. Rooms are no longer supported; its conversation stays in the backup file.");
    // Exporting never repairs or removes the original records in place.
    expect(store.group(group.id)?.memberIds).toEqual([chief.id, scout.id]);
  });
});
