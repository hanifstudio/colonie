import { AlertCircleIcon, ArrowLeft01Icon, AttachmentIcon, CancelCircleIcon, CheckmarkCircle02Icon, ChevronLeftIcon, ChevronRightIcon, Clock03Icon, Delete02Icon, FileTextIcon, LaptopIcon, Loading02Icon, MultiplicationSignIcon, PauseIcon, PlayIcon, PlusSignIcon, RepeatIcon, Search01Icon, SquareArrowUpRightIcon, TickDouble01Icon, UserAdd01Icon, UsersIcon, Video01Icon, WebhookIcon } from "@hugeicons/core-free-icons";
import { HIcon } from "./HIcon";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  type CSSProperties,
  type ReactNode,
} from "react";

import { BotAvatar } from "@/components/Avatar";
import { useBotEditor } from "./bot-settings/BotEditorContext";
import { pathForFile } from "@/components/ComposerAttachments";
import { CalendarSidebar } from "@/components/routines/CalendarSidebar";
import { RoutineList } from "@/components/routines/RoutineList";
import { RoutineLogs } from "@/components/routines/RoutineLogs";
import { ResultsDestination } from "@/components/routines/ResultsDestination";
import { CronScheduleFields, CronSchedulePreview } from "@/components/routines/CronScheduleFields";
import { cronChoiceFor, cronDraftFor, cronEditorValue, isCronChoice, type CronChoice } from "@/components/routines/cron-editor";
import { routineRunLabel, routineRunsOn, routineRunTime, routineScheduleState } from "@/lib/routine-display";
import { useAdvancedMode } from "@/lib/interface-mode";
import { t } from "@/lib/i18n";
import { useModalDialog } from "@/hooks/use-modal-dialog";
import { useDesktopCapabilities } from "@/components/DesktopCapabilities";
import { WebhooksPanel } from "@/components/WebhooksPanel";
import type { CalendarCall, CalendarCallAttachment, CalendarCallInput } from "@/lib/calendar-calls";
import { cn } from "@/lib/cn";
import {
  imageAttachmentFromFile,
  intakeFiles,
  type Attachment,
} from "@/lib/composer-attachments";
import { MAUS_COLORS, type MausState } from "@/lib/mascot";
import {
  addDays,
  atLocalTime,
  CALENDAR_SLOT_MINUTES,
  calendarRangeLabel,
  formatGmtOffset,
  fromLocalDateAndTime,
  intervalAnchorForSave,
  nextIntervalForSave,
  packCalendarCollisions,
  projectedRoutineItems,
  scheduleAt,
  slotAt,
  startOfDay,
  startOfWeek,
  toLocalDateInput,
  toLocalTimeInput,
  type RoutineCalendarItem,
} from "@/lib/routine-calendar";
import { DAY_NAMES, durationLabel, intervalLabel, niceDate, niceTime, scheduleLabel } from "@/lib/schedule-label";
import { Switch } from "./SettingsPrimitives";
import {
  isRoutineProblemRun,
  type Routine,
  type RoutineContextAttachment,
  type RoutineInput,
  type RoutineRunOn,
  type RoutineRun,
  type RoutineRunStatus,
  type RoutineRunStatusFilter,
  type RoutineSchedule,
  type RoutineScheduleInput,
} from "@/lib/routines";
import { api, openNotificationTarget, useStore, type Bot } from "@/state/store";

const HOUR_HEIGHT = 64;
const DAY_CHIP_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAYS = [1, 2, 3, 4, 5];
const INTERVAL_PRESETS = [5, 10, 15, 30, 60];
const EVENT_DURATION_OPTIONS = Array.from({ length: 240 / CALENDAR_SLOT_MINUTES }, (_, index) => (index + 1) * CALENDAR_SLOT_MINUTES);
const BOT_DRAG_TYPE = "application/x-colonie";
const EVENT_DRAG_TYPE = "application/x-colonie-calendar-event";

type EventKind = "routine" | "call";
type RoutinesLayout = "day" | "week" | "list";
type CalendarRecurrenceChoice = "none" | "daily" | "weekdays" | "weekly" | "custom";
type RecurrenceChoice = CalendarRecurrenceChoice | "interval" | CronChoice;
type IntervalDayChoice = "every-day" | "weekdays" | "custom";
type IntervalWindowChoice = "all-day" | "custom";
type IntervalEndChoice = "never" | "on-date";

type CallOccurrence = {
  id: string;
  at: number;
  durationMinutes: number;
  call: CalendarCall;
};

type CalendarEventItem =
  | ({ kind: "routine" } & RoutineCalendarItem)
  | ({ kind: "call" } & CallOccurrence);

type EventSeed = {
  kind: EventKind;
  at: number;
  durationMinutes: number;
  botIds: string[];
  name?: string;
  description?: string;
  resultsThreadId?: string | null;
  anchor?: { x: number; y: number };
  routine?: Routine;
  call?: CalendarCall;
};

function nextHour(): number {
  const date = new Date(Date.now() + 60 * 60_000);
  date.setMinutes(0, 0, 0);
  return date.getTime();
}

function sameDays(left: readonly number[] | undefined, right: readonly number[]): boolean {
  return Boolean(left && left.length === right.length && left.every((day, index) => day === right[index]));
}

function intervalDayChoice(schedule: RoutineSchedule | CalendarCall["schedule"]): IntervalDayChoice {
  if (schedule.type !== "interval" || !schedule.weekdays || schedule.weekdays.length === 7) return "every-day";
  return sameDays(schedule.weekdays, WEEKDAYS) ? "weekdays" : "custom";
}

function endOfLocalDate(dateInput: string): number {
  const date = new Date(`${dateInput}T00:00`);
  date.setHours(23, 59, 59, 999);
  return date.getTime();
}
function recurrenceFor(schedule: RoutineSchedule | CalendarCall["schedule"], at: number): RecurrenceChoice {
  if (schedule.type === "once") return "none";
  if (schedule.type === "interval") return "interval";
  if (schedule.type === "cron") return cronChoiceFor(schedule);
  if (schedule.weekdays.length === 7) return "daily";
  if (schedule.weekdays.join(",") === "1,2,3,4,5") return "weekdays";
  if (schedule.weekdays.length === 1 && schedule.weekdays[0] === new Date(at).getDay()) return "weekly";
  return "custom";
}

function makeCalendarSchedule(choice: CalendarRecurrenceChoice, at: number, weekdays: number[]): CalendarCall["schedule"] {
  if (choice === "none") return { type: "once", at };
  const selected = choice === "daily"
    ? ALL_DAYS
    : choice === "weekdays"
      ? WEEKDAYS
      : choice === "weekly"
        ? [new Date(at).getDay()]
        : weekdays;
  return { type: "daily", time: toLocalTimeInput(at), weekdays: [...selected].sort() };
}

function makeRoutineSchedule(
  choice: Exclude<RecurrenceChoice, CronChoice>,
  at: number,
  weekdays: number[],
  everyMinutes: number,
  interval: {
    anchorAt: number;
    weekdays: number[] | null;
    window: { start: string; end: string } | null;
    endsAt: number | null;
  },
): RoutineScheduleInput {
  if (choice === "interval") return { type: "interval", everyMinutes, ...interval };
  return makeCalendarSchedule(choice, at, weekdays);
}

function projectCalls(calls: CalendarCall[], from: number, to: number): CallOccurrence[] {
  const items: CallOccurrence[] = [];
  for (const call of calls) {
    if (call.schedule.type === "once") {
      if (call.schedule.at >= from && call.schedule.at < to) {
        items.push({ id: `call-${call.id}-${call.schedule.at}`, at: call.schedule.at, durationMinutes: call.durationMinutes, call });
      }
      continue;
    }
    for (let day = startOfDay(from); day < to; day = addDays(day, 1)) {
      if (!call.schedule.weekdays.includes(new Date(day).getDay())) continue;
      const at = atLocalTime(day, call.schedule.time);
      if (at >= from && at < to && at >= call.createdAt) {
        items.push({ id: `call-${call.id}-${at}`, at, durationMinutes: call.durationMinutes, call });
      }
    }
  }
  return items.sort((left, right) => left.at - right.at);
}

function statusState(status: RoutineRunStatus): MausState {
  if (status === "running") return "working";
  if (status === "waiting") return "curious";
  if (status === "completed") return "proud";
  if (status === "failed" || status === "missed") return "sad";
  if (status === "cancelled") return "sleeping";
  return "drowsy";
}

function AttachmentChips({
  attachments,
  onRemove,
}: {
  attachments: Array<RoutineContextAttachment | CalendarCallAttachment>;
  onRemove?: (id: string) => void;
}) {
  if (!attachments.length) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {attachments.map((attachment) => (
        <div key={attachment.id} className="flex max-w-[260px] items-center gap-2 rounded-lg border border-hairline/50 bg-inset px-2.5 py-2 text-[12px] text-ink">
          <HIcon icon={FileTextIcon} size={14} className="shrink-0 text-accent" />
          <span className="min-w-0 flex-1 truncate">{attachment.name}</span>
          {onRemove && <button type="button" onClick={() => onRemove(attachment.id)} className="rounded p-0.5 text-ink-secondary hover:bg-raised hover:text-ink" aria-label={`Remove ${attachment.name}`}><HIcon icon={MultiplicationSignIcon} size={12} /></button>}
        </div>
      ))}
    </div>
  );
}

function BotPicker({
  bots,
  selected,
  multiple,
  locked,
  onChange,
}: {
  bots: Bot[];
  selected: string[];
  multiple: boolean;
  locked?: boolean;
  onChange: (ids: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = bots.filter((bot) => `${bot.name} ${bot.title}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <div className="rounded-xl border border-hairline/50 bg-inset/60 p-2">
      {!locked && bots.length > 5 && (
        <label className="mb-2 flex items-center gap-2 rounded-lg border border-transparent bg-panel px-2.5 py-2 text-ink-secondary focus-within:border-focus">
          <HIcon icon={Search01Icon} size={14} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a bot" className="min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-ink-tertiary" />
        </label>
      )}
      <div className="grid max-h-48 grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2">
        {filtered.map((bot) => {
          const active = selected.includes(bot.id);
          return (
            <button
              key={bot.id}
              type="button"
              disabled={locked}
              onClick={() => onChange(multiple ? (active ? selected.filter((id) => id !== bot.id) : [...selected, bot.id]) : [bot.id])}
              className={cn("flex min-w-0 items-center gap-2 rounded-lg px-2 py-2 text-left transition", active ? "bg-accent/12 ring-1 ring-accent/50" : "hover:bg-raised", locked && "cursor-default")}
            >
              <BotAvatar bot={bot} state={active ? "happy" : "idle"} size={32} animated={false} />
              <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">{bot.name}</span>
              {active && <HIcon icon={CheckmarkCircle02Icon} size={14} className="shrink-0 text-accent" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function toContextAttachments(attachments: Attachment[]): Array<RoutineContextAttachment | CalendarCallAttachment> {
  return attachments.flatMap((attachment) => attachment.kind === "paste" || attachment.kind === "citation" ? [] : [{
    id: attachment.id,
    kind: attachment.kind,
    name: attachment.name,
    path: attachment.path,
    size: attachment.size,
  }]);
}

export function EventEditor({
  seed,
  bots,
  lockedBotId,
  defaultRunOn,
  routinesOnly = false,
  onClose,
  onSavedCall,
}: {
  seed: EventSeed;
  bots: Bot[];
  lockedBotId?: string;
  defaultRunOn?: RoutineRunOn;
  routinesOnly?: boolean;
  onClose: () => void;
  onSavedCall: (call: CalendarCall) => void;
}) {
  const { dispatch } = useStore();
  const existingRoutine = seed.routine;
  const { request: editorRequest } = useBotEditor();
  const existingCall = seed.call;
  const [kind, setKind] = useState<EventKind>(routinesOnly ? "routine" : seed.kind);
  const [editorOpenedAt] = useState(() => Date.now());
  const [name, setName] = useState(existingRoutine?.name ?? existingCall?.name ?? seed.name ?? "");
  const [description, setDescription] = useState(existingRoutine?.prompt ?? existingCall?.description ?? seed.description ?? "");
  const initialAt = existingRoutine?.schedule.type === "once"
    ? existingRoutine.schedule.at
    : existingRoutine?.schedule.type === "daily"
      ? atLocalTime(seed.at, existingRoutine.schedule.time)
      : existingRoutine?.schedule.type === "interval"
        ? existingRoutine.schedule.anchorAt
      : existingCall?.schedule.type === "once"
        ? existingCall.schedule.at
        : existingCall?.schedule.type === "daily"
          ? atLocalTime(seed.at, existingCall.schedule.time)
          : seed.at;
  const schedule = existingRoutine?.schedule ?? existingCall?.schedule ?? { type: "once" as const, at: initialAt };
  const [date, setDate] = useState(toLocalDateInput(initialAt));
  const [startTime, setStartTime] = useState(toLocalTimeInput(initialAt));
  const [durationMinutes, setDurationMinutes] = useState(existingRoutine?.durationMinutes ?? existingCall?.durationMinutes ?? seed.durationMinutes);
  const [timeoutMinutes, setTimeoutMinutes] = useState<number | null>(
    existingRoutine?.timeoutMinutes ?? null,
  );
  const [intervalTimeoutDefaultApplied, setIntervalTimeoutDefaultApplied] = useState(Boolean(existingRoutine));
  const [overlap, setOverlap] = useState<"skip" | "queue">(existingRoutine?.overlap ?? "skip");
  const [continuity, setContinuity] = useState(Boolean(existingRoutine?.continuity));
  const [recurrence, setRecurrence] = useState<RecurrenceChoice>(recurrenceFor(schedule, initialAt));
  const [cronDraft, setCronDraft] = useState(() => cronDraftFor(schedule.type === "cron" ? schedule : undefined, initialAt));
  const [cronChanged, setCronChanged] = useState(false);
  const [weekdays, setWeekdays] = useState(schedule.type === "daily" ? schedule.weekdays : [new Date(initialAt).getDay()]);
  const [intervalMinutes, setIntervalMinutes] = useState(schedule.type === "interval" ? schedule.everyMinutes : 15);
  const [intervalDays, setIntervalDays] = useState<IntervalDayChoice>(() => intervalDayChoice(schedule));
  const [intervalWeekdays, setIntervalWeekdays] = useState(() => schedule.type === "interval" && schedule.weekdays?.length
    ? schedule.weekdays
    : [...ALL_DAYS]);
  const [intervalWindow, setIntervalWindow] = useState<IntervalWindowChoice>(schedule.type === "interval" && schedule.window ? "custom" : "all-day");
  const [intervalWindowStart, setIntervalWindowStart] = useState(schedule.type === "interval" ? schedule.window?.start ?? "09:00" : "09:00");
  const [intervalWindowEnd, setIntervalWindowEnd] = useState(schedule.type === "interval" ? schedule.window?.end ?? "17:00" : "17:00");
  const [intervalEnd, setIntervalEnd] = useState<IntervalEndChoice>(schedule.type === "interval" && schedule.endsAt != null ? "on-date" : "never");
  const [intervalEndDate, setIntervalEndDate] = useState(() => schedule.type === "interval" && schedule.endsAt != null
    ? toLocalDateInput(schedule.endsAt)
    : toLocalDateInput(addDays(startOfDay(Math.max(Date.now(), initialAt)), 7)));
  const [botIds, setBotIds] = useState(lockedBotId ? [lockedBotId] : existingRoutine ? [existingRoutine.botId] : existingCall?.botIds ?? seed.botIds);
  const [resultsThreadId, setResultsThreadId] = useState<string | null | undefined>(existingRoutine ? existingRoutine.resultsThreadId : seed.resultsThreadId ?? null);
  const selectBots = (ids: string[]) => {
    if (ids[0] !== botIds[0]) setResultsThreadId(null);
    setBotIds(ids);
  };
  // Every routine is a bot routine. A stored team goal (from retired rooms) can
  // still be opened, but only to read its paused notice; it cannot be saved.
  const legacyTeamGoal = kind === "routine" && existingRoutine?.target === "room-goal";
  // ponytail: a routine stored before the cloud computer place was removed can
  // still say `runOn: "cloud"`; it now runs on the bot's own computer.
  const runOn: RoutineRunOn = existingRoutine?.runOn === "cloud" ? "maus" : existingRoutine?.runOn ?? defaultRunOn ?? "maus";
  const [attachments, setAttachments] = useState<Array<RoutineContextAttachment | CalendarCallAttachment>>(
    existingRoutine?.target === "room-goal" ? [] : existingRoutine?.attachments ?? existingCall?.attachments ?? [],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [attachmentNotice, setAttachmentNotice] = useState("");
  const [attachmentPendingCount, setAttachmentPendingCount] = useState(0);
  const attachmentPending = attachmentPendingCount > 0;
  const fileInput = useRef<HTMLInputElement>(null);
  const at = fromLocalDateAndTime(date, startTime, existingRoutine || existingCall ? initialAt : undefined);
  const endAt = at + durationMinutes * 60_000;
  const selectedBots = botIds.flatMap((id) => bots.find((bot) => bot.id === id) ?? []);
  const dialogRef = useRef<HTMLDivElement>(null);
  const intervalInvalid = recurrence === "interval"
    && (!Number.isInteger(intervalMinutes) || intervalMinutes < 5 || intervalMinutes > 1_440);
  const intervalDaysInvalid = recurrence === "interval" && intervalDays === "custom" && intervalWeekdays.length === 0;
  const intervalWindowMinutes = fromLocalDateAndTime("2000-01-01", intervalWindowEnd)
    - fromLocalDateAndTime("2000-01-01", intervalWindowStart);
  const intervalWindowInvalid = recurrence === "interval"
    && intervalWindow === "custom"
    && (!intervalWindowStart
      || !intervalWindowEnd
      || !Number.isFinite(intervalWindowMinutes)
      || intervalWindowMinutes < intervalMinutes * 60_000);
  const existingIntervalSchedule = existingRoutine?.schedule.type === "interval"
    ? existingRoutine.schedule
    : undefined;
  const intervalEndMinimumAt = nextIntervalForSave(
    editorOpenedAt,
    Math.max(5, intervalMinutes || 5),
    existingIntervalSchedule,
  );
  const intervalEndsAt = intervalEnd === "on-date" ? endOfLocalDate(intervalEndDate) : null;
  const intervalEndInvalid = recurrence === "interval"
    && intervalEnd === "on-date"
    && (intervalEndsAt == null || !Number.isSafeInteger(intervalEndsAt) || intervalEndsAt < intervalEndMinimumAt);
  const selectedIntervalWeekdays = intervalDays === "every-day"
    ? undefined
    : intervalDays === "weekdays"
      ? WEEKDAYS
      : intervalWeekdays;
  const selectedIntervalWindow = intervalWindow === "custom"
    ? { start: intervalWindowStart, end: intervalWindowEnd }
    : undefined;
  const cron = isCronChoice(recurrence)
    ? cronEditorValue(recurrence, cronDraft, editorOpenedAt, !cronChanged && schedule.type === "cron" ? schedule : undefined)
    : null;

  const selectRecurrence = (choice: RecurrenceChoice) => {
    if (choice === "interval" && !intervalTimeoutDefaultApplied) {
      setTimeoutMinutes((current) => current ?? 30);
      setIntervalTimeoutDefaultApplied(true);
    }
    if (isCronChoice(choice)) {
      // Switching from a preset to Advanced starts with what the person chose.
      if (choice === "cron" && cron?.schedule) setCronDraft((draft) => ({ ...draft, expression: cron.schedule!.expression }));
      setCronChanged(true);
    }
    setRecurrence(choice);
  };

  const selectIntervalDays = (choice: IntervalDayChoice) => {
    if (choice === "custom" && intervalDays !== "custom") {
      setIntervalWeekdays(intervalDays === "weekdays" ? [...WEEKDAYS] : [...ALL_DAYS]);
    }
    setIntervalDays(choice);
  };

  const pickFiles = async (files: FileList | null) => {
    if (!files?.length || legacyTeamGoal) return;
    setAttachmentPendingCount((count) => count + 1);
    try {
      const result = await intakeFiles(Array.from(files), {
        allowImages: true,
        getPath: pathForFile,
        uploadImage: imageAttachmentFromFile,
      });
      const added = toContextAttachments(result.attachments);
      if (added.length) {
        setAttachments((current) => [...current, ...added].slice(0, 20));
      }
      if (result.notice) setAttachmentNotice(result.notice);
    } finally {
      setAttachmentPendingCount((count) => Math.max(0, count - 1));
    }
  };

  const save = async () => {
    if (attachmentPending) return;
    setSaving(true);
    setError("");
    try {
      if (kind === "routine" || routinesOnly) {
        const savedAt = Date.now();
        const intervalAnchorAt = intervalAnchorForSave(savedAt, intervalMinutes, existingIntervalSchedule);
        if (recurrence === "interval" && intervalEndsAt != null && intervalEndsAt < nextIntervalForSave(savedAt, intervalMinutes, existingIntervalSchedule)) {
          throw new Error("Choose an end date after the first run.");
        }
        const nextSchedule = isCronChoice(recurrence) ? cron?.schedule : makeRoutineSchedule(recurrence, at, weekdays, intervalMinutes, {
          anchorAt: intervalAnchorAt,
          weekdays: selectedIntervalWeekdays ? [...selectedIntervalWeekdays].sort() : null,
          window: selectedIntervalWindow ?? null,
          endsAt: intervalEndsAt,
        });
        if (!nextSchedule) throw new Error(cron?.error || "Choose a valid schedule.");
        const input: RoutineInput = {
          name,
          prompt: description,
          target: "bot",
          botId: lockedBotId ?? botIds[0] ?? "",
          runOn,
          enabled: existingRoutine ? undefined : true,
          schedule: nextSchedule,
          durationMinutes,
          timeoutMinutes,
          overlap,
          // A one-time run has no next run to carry a report into.
          continuity: recurrence !== "none" && continuity,
          attachments: attachments as RoutineContextAttachment[],
          resultsThreadId: existingRoutine?.conversation ? undefined : resultsThreadId,
        };
        const response = await editorRequest(existingRoutine ? `/api/routines/${existingRoutine.id}` : "/api/routines", {
          method: existingRoutine ? "PATCH" : "POST",
          body: JSON.stringify(input),
        });
        dispatch({ type: "routinePatched", routine: response.routine });
      } else {
        if (recurrence === "interval" || isCronChoice(recurrence)) throw new Error("Choose a supported call schedule.");
        const nextSchedule = makeCalendarSchedule(recurrence, at, weekdays);
        const input: CalendarCallInput = {
          name,
          description,
          botIds,
          schedule: nextSchedule,
          durationMinutes,
          attachments: attachments as CalendarCallAttachment[],
        };
        const response = await api(existingCall ? `/api/calendar-calls/${existingCall.id}` : "/api/calendar-calls", {
          method: existingCall ? "PATCH" : "POST",
          body: JSON.stringify(input),
        });
        onSavedCall(response.call);
      }
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const valid = Boolean(
    name.trim()
    && (kind === "call" || description.trim())
    && (!lockedBotId || botIds[0] === lockedBotId)
    && (kind === "call"
      ? botIds.length > 0
      // Team goals were retired with rooms; a stored one stays inert.
      : !legacyTeamGoal && botIds.length > 0)
    && !intervalInvalid
    && !intervalDaysInvalid
    && !intervalWindowInvalid
    && !intervalEndInvalid
    && !cron?.error,
  );
  const canSwitchKind = !routinesOnly && !existingRoutine && !existingCall && !lockedBotId;
  const advanced = useAdvancedMode();
  // Simple mode keeps the basics up front. A schedule or setting the basics
  // cannot show opens More options straight away, so nothing saved is hidden.
  const [moreOpen, setMoreOpen] = useState(() => !(["none", "daily", "weekdays", "weekly"] as RecurrenceChoice[]).includes(recurrence)
    || legacyTeamGoal
    || attachments.length > 0
    || timeoutMinutes != null
    || overlap === "queue");

  useModalDialog(dialogRef, onClose);

  const kindSwitchControl = canSwitchKind && (
            <div className={cn(advanced && "ml-10", "inline-flex rounded-lg bg-inset p-1")}>
              <button type="button" onClick={() => { setKind("routine"); setBotIds((ids) => ids.slice(0, 1)); }} className={cn("rounded-md px-4 py-1.5 text-[12.5px] font-medium", kind === "routine" ? "bg-raised text-ink shadow" : "text-ink-secondary")}>Routine</button>
              <button type="button" onClick={() => { setKind("call"); if (recurrence === "interval" || isCronChoice(recurrence)) setRecurrence("none"); }} className={cn("rounded-md px-4 py-1.5 text-[12.5px] font-medium", kind === "call" ? "bg-raised text-ink shadow" : "text-ink-secondary")}>Call</button>
            </div>
          );
  const routineTypeControl = legacyTeamGoal && (
            <div className={cn(advanced && "ml-10", "rounded-xl border border-warning/30 bg-warning/10 px-3.5 py-3 text-[11.5px] leading-relaxed text-warning")}>
              Team goals are no longer available. This routine stays paused; recreate it as a bot routine to run it again.
            </div>
          );
  const whenControls = recurrence !== "interval" && !isCronChoice(recurrence) && (
                <div className="flex flex-wrap items-center gap-2">
                  {kind === "routine" && recurrence === "none" && <span className="text-[12px] font-medium text-ink-secondary">Starts</span>}
                  {kind === "routine" && recurrence === "weekly" && <span className="text-[12px] font-medium text-ink-secondary">On</span>}
                  {(kind === "call" || recurrence === "none" || recurrence === "weekly") && <input type="date" value={date} onChange={(event) => setDate(event.target.value)} className="rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px] text-ink outline-none focus:border-accent [color-scheme:dark]" />}
                  <input type="time" step={CALENDAR_SLOT_MINUTES * 60} value={startTime} onChange={(event) => setStartTime(event.target.value)} className="rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px] text-ink outline-none focus:border-accent [color-scheme:dark]" />
                  {kind === "call" && <>
                    <span className="text-[12px] text-ink-secondary">to</span>
                    <span className="rounded-lg border border-hairline/40 bg-inset/60 px-3 py-2 text-[13px] text-ink">{niceTime(endAt)}</span>
                    <select aria-label="Call duration" value={durationMinutes} onChange={(event) => setDurationMinutes(Number(event.target.value))} className="rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[12px] text-ink outline-none focus:border-accent">
                      {EVENT_DURATION_OPTIONS.map((minutes) => <option key={minutes} value={minutes}>{durationLabel(minutes)}</option>)}
                    </select>
                  </>}
                </div>
              );
  const repeatSelect = (
              <div className="flex flex-wrap items-center gap-2">
                <HIcon icon={RepeatIcon} size={14} className="text-ink-secondary" />
                <select aria-label="Repeat" value={recurrence} onChange={(event) => selectRecurrence(event.target.value as RecurrenceChoice)} className="rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[12.5px] text-ink outline-none focus:border-accent">
                  <option value="none">Does not repeat</option>
                  {kind === "routine" && <option value="interval">Every X minutes</option>}
                  <option value="daily">Daily</option>
                  <option value="weekdays">Every weekday (Monday to Friday)</option>
                  <option value="weekly">Weekly on {DAY_NAMES[new Date(at).getDay()]}</option>
                  <option value="custom">Selected weekdays</option>
                  {kind === "routine" && <><option value="monthly">Monthly</option><option value="yearly">Yearly</option><option value="cron">Custom cron (advanced)</option></>}
                </select>
              </div>
  );
  const scheduleNote = kind === "routine" && (
                <p className="text-[11px] leading-relaxed text-ink-secondary">
                  Runs while Colonie is open on this computer — it cannot wake a sleeping Mac. A run missed by less than 12 hours still happens when the app is back.
                </p>
              );
  const repeatDetails = (
    <>
              {isCronChoice(recurrence) && kind === "routine" && cron && <CronScheduleFields choice={recurrence} value={cronDraft} onChange={(draft) => { setCronDraft(draft); setCronChanged(true); }} runs={cron.runs} error={cron.error} />}
              {recurrence === "custom" && (
                <div className="flex flex-wrap gap-1.5">
                  {DAY_NAMES.map((label, day) => <button key={label} type="button" onClick={() => setWeekdays((current) => current.includes(day) ? (current.length === 1 ? current : current.filter((value) => value !== day)) : [...current, day].sort())} className={cn("size-8 rounded-full text-[10px] font-semibold", weekdays.includes(day) ? "bg-accent text-white" : "bg-inset text-ink-secondary hover:bg-raised hover:text-ink")}>{label[0]}</button>)}
                </div>
              )}
              {recurrence === "interval" && kind === "routine" && (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink">
                    <span className="font-medium">Runs every</span>
                    <select
                      value={INTERVAL_PRESETS.includes(intervalMinutes) ? String(intervalMinutes) : "custom"}
                      onChange={(event) => setIntervalMinutes(event.target.value === "custom" ? 0 : Number(event.target.value))}
                      aria-label="How often this routine runs"
                      className="rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[12.5px] tabular-nums text-ink outline-none focus:border-accent"
                    >
                      {INTERVAL_PRESETS.map((minutes) => <option key={minutes} value={minutes}>{minutes}</option>)}
                      <option value="custom">Custom…</option>
                    </select>
                    {!INTERVAL_PRESETS.includes(intervalMinutes) && (
                      <input
                        type="number"
                        min={5}
                        max={1_440}
                        step={1}
                        value={intervalMinutes || ""}
                        onChange={(event) => setIntervalMinutes(Number(event.target.value))}
                        aria-label="Custom interval in minutes"
                        aria-invalid={intervalInvalid}
                        aria-describedby={intervalInvalid ? "routine-interval-error" : "routine-interval-help"}
                        autoFocus
                        className={cn("w-20 rounded-lg border bg-inset px-3 py-2 text-[12.5px] tabular-nums text-ink outline-none focus:border-accent", intervalInvalid ? "border-danger/70" : "border-hairline/50")}
                      />
                    )}
                    <span>minutes</span>
                  </div>

                  <div className="grid items-center gap-2 text-[12.5px] text-ink sm:flex sm:flex-wrap">
                    <span className="inline-flex items-center gap-2 whitespace-nowrap">
                      <span className="font-medium">On</span>
                      <select
                        value={intervalDays}
                        onChange={(event) => selectIntervalDays(event.target.value as IntervalDayChoice)}
                        aria-label="Days this interval runs"
                        aria-invalid={intervalDaysInvalid}
                        aria-describedby={intervalDaysInvalid ? "routine-interval-days-error" : undefined}
                        className="rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[12.5px] text-ink outline-none focus:border-accent"
                      >
                        <option value="every-day">Every day</option>
                        <option value="weekdays">Weekdays</option>
                        <option value="custom">Custom…</option>
                      </select>
                    </span>
                    <span aria-hidden="true" className="hidden text-ink-secondary sm:inline">·</span>
                    <span className="inline-flex items-center gap-2 whitespace-nowrap">
                      <span className="font-medium">During</span>
                      <select
                        value={intervalWindow}
                        onChange={(event) => setIntervalWindow(event.target.value as IntervalWindowChoice)}
                        aria-label="Hours this interval runs"
                        aria-invalid={intervalWindowInvalid}
                        aria-describedby={intervalWindowInvalid ? "routine-interval-window-error" : undefined}
                        className="rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[12.5px] text-ink outline-none focus:border-accent"
                      >
                        <option value="all-day">All day</option>
                        <option value="custom">Custom hours…</option>
                      </select>
                    </span>
                    <span aria-hidden="true" className="hidden text-ink-secondary sm:inline">·</span>
                    <span className="inline-flex items-center gap-2 whitespace-nowrap">
                      <span className="font-medium">Ends</span>
                      <select
                        value={intervalEnd}
                        onChange={(event) => setIntervalEnd(event.target.value as IntervalEndChoice)}
                        aria-label="When this interval ends"
                        aria-invalid={intervalEndInvalid}
                        aria-describedby={intervalEndInvalid ? "routine-interval-end-error" : undefined}
                        className="rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[12.5px] text-ink outline-none focus:border-accent"
                      >
                        <option value="never">Never</option>
                        <option value="on-date">On a date…</option>
                      </select>
                    </span>
                  </div>

                  {intervalDays === "custom" && (
                    <div>
                      <div className="mb-2 text-[11px] font-medium text-ink-secondary">Choose the days</div>
                      <div
                        role="group"
                        aria-label="Custom interval days"
                        aria-invalid={intervalDaysInvalid}
                        aria-describedby={intervalDaysInvalid ? "routine-interval-days-error" : undefined}
                        className="flex flex-wrap gap-1.5"
                      >
                        {DAY_NAMES.map((label, day) => (
                          <button
                            key={label}
                            type="button"
                            onClick={() => setIntervalWeekdays((current) => current.includes(day)
                              ? current.filter((value) => value !== day)
                              : [...current, day].sort())}
                            aria-label={`${label}, ${intervalWeekdays.includes(day) ? "selected" : "not selected"}`}
                            aria-pressed={intervalWeekdays.includes(day)}
                            className={cn("size-8 rounded-full text-[10px] font-semibold", intervalWeekdays.includes(day) ? "bg-accent text-white" : "bg-inset text-ink-secondary hover:bg-raised hover:text-ink")}
                          >
                            {DAY_CHIP_LABELS[day]}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {intervalWindow === "custom" && (
                    <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink">
                      <span className="font-medium text-ink-secondary">Run between</span>
                      <input aria-label="Interval window start" aria-invalid={intervalWindowInvalid} aria-describedby={intervalWindowInvalid ? "routine-interval-window-error" : undefined} type="time" step={CALENDAR_SLOT_MINUTES * 60} value={intervalWindowStart} onChange={(event) => setIntervalWindowStart(event.target.value)} className={cn("rounded-lg border bg-inset px-3 py-2 text-[13px] text-ink outline-none focus:border-accent [color-scheme:dark]", intervalWindowInvalid ? "border-danger/70" : "border-hairline/50")} />
                      <span className="text-ink-secondary">and</span>
                      <input aria-label="Interval window end" aria-invalid={intervalWindowInvalid} aria-describedby={intervalWindowInvalid ? "routine-interval-window-error" : undefined} type="time" step={CALENDAR_SLOT_MINUTES * 60} value={intervalWindowEnd} onChange={(event) => setIntervalWindowEnd(event.target.value)} className={cn("rounded-lg border bg-inset px-3 py-2 text-[13px] text-ink outline-none focus:border-accent [color-scheme:dark]", intervalWindowInvalid ? "border-danger/70" : "border-hairline/50")} />
                    </div>
                  )}

                  {intervalEnd === "on-date" && (
                    <label className="flex flex-wrap items-center gap-2 text-[12px] text-ink">
                      <span className="font-medium text-ink-secondary">Stop scheduling after</span>
                      <input aria-label="Interval end date" aria-invalid={intervalEndInvalid} aria-describedby={intervalEndInvalid ? "routine-interval-end-error" : undefined} type="date" min={toLocalDateInput(intervalEndMinimumAt)} value={intervalEndDate} onChange={(event) => setIntervalEndDate(event.target.value)} className={cn("rounded-lg border bg-inset px-3 py-2 text-[13px] text-ink outline-none focus:border-accent [color-scheme:dark]", intervalEndInvalid ? "border-danger/70" : "border-hairline/50")} />
                    </label>
                  )}

                  {intervalInvalid && (
                    <div id="routine-interval-error" className="text-[11px] text-danger">Choose a whole number from 5 to 1,440 minutes.</div>
                  )}
                  {intervalDaysInvalid && (
                    <div id="routine-interval-days-error" className="text-[11px] text-danger">Choose at least one day.</div>
                  )}
                  {intervalWindowInvalid && (
                    <div id="routine-interval-window-error" className="text-[11px] text-danger">Choose a same-day window at least {intervalMinutes || 5} minutes long.</div>
                  )}
                  {intervalEndInvalid && (
                    <div id="routine-interval-end-error" className="text-[11px] text-danger">Choose an end date after the first run.</div>
                  )}
                  <div id="routine-interval-help" className="text-[11px] leading-relaxed text-ink-secondary">{t(overlap === "queue" ? "routines.overlapQueueHelp" : "routines.overlapSkipHelp")}</div>
                </div>
              )}
    </>
  );
  const runLimitControls = kind === "routine" && (
                <details className="rounded-xl border border-hairline/40 bg-inset/40 px-3 py-2.5">
                  <summary className="cursor-pointer select-none text-[11.5px] font-medium text-ink-secondary hover:text-ink">
                    Advanced · {timeoutMinutes == null ? "no run limit" : `${durationLabel(timeoutMinutes)} run limit`}
                  </summary>
                  <div className="mt-3 border-t border-hairline/35 pt-3">
                    <label className="flex flex-wrap items-center gap-2 text-[12px] text-ink">
                      <span>Stop if still running after</span>
                      <select aria-label="Routine safety limit" value={timeoutMinutes ?? ""} onChange={(event) => setTimeoutMinutes(event.target.value ? Number(event.target.value) : null)} className="rounded-lg border border-hairline/50 bg-panel px-3 py-2 text-[12px] text-ink outline-none focus:border-accent">
                        <option value="">No limit</option>
                        {EVENT_DURATION_OPTIONS.map((minutes) => <option key={minutes} value={minutes}>{durationLabel(minutes)}</option>)}
                      </select>
                    </label>
                    <div className="mt-1.5 text-[10.5px] leading-relaxed text-ink-secondary">Optional. The clock starts when work actually begins and does not control how often the routine starts.</div>
                    {recurrence !== "none" && <div className="mt-3">
                      <label className="flex flex-wrap items-center gap-2 text-[12px] text-ink">
                        <span>{t("routines.overlapLabel")}</span>
                        <select aria-label={t("routines.overlapLabel")} value={overlap} onChange={event => setOverlap(event.target.value === "queue" ? "queue" : "skip")} className="rounded-lg border border-hairline/50 bg-panel px-3 py-2 text-[12px] text-ink outline-none focus:border-accent">
                          <option value="skip">{t("routines.overlapSkip")}</option>
                          <option value="queue">{t("routines.overlapQueue")}</option>
                        </select>
                      </label>
                      <p className="mt-1.5 text-[10.5px] leading-relaxed text-ink-secondary">{t(overlap === "queue" ? "routines.overlapQueueHelp" : "routines.overlapSkipHelp")}</p>
                    </div>}
                  </div>
                </details>
              );
  const continuityControl = kind === "routine" && !legacyTeamGoal && recurrence !== "none" && (
          <label className={cn("flex items-start gap-3 rounded-xl border border-hairline/40 bg-inset/40 px-3.5 py-3", advanced && "ml-8")}>
            <input type="checkbox" aria-label={t("routines.continuityLabel")} checked={continuity} onChange={(event) => setContinuity(event.target.checked)} className="mt-0.5 accent-accent" />
            <span>
              <span className="block text-[12.5px] font-medium text-ink">{t("routines.continuityLabel")}</span>
              <span className="mt-1 block text-[11px] leading-relaxed text-ink-secondary">{t("routines.continuityHelp")}</span>
            </span>
          </label>
        );
  const resultsControl = kind === "routine" && !legacyTeamGoal && <div className={cn(advanced && "ml-8")}>
            {existingRoutine?.conversation ? <p className="text-[12.5px] text-ink-secondary">Reports to the conversation where it was scheduled.</p> : <ResultsDestination bot={bots.find((bot) => bot.id === botIds[0])} value={resultsThreadId} allowCurrent={Boolean(existingRoutine)} onChange={setResultsThreadId} />}
          </div>;
  const attachmentsRow = !legacyTeamGoal && (
          <div className="flex items-start gap-4">
            <HIcon icon={AttachmentIcon} size={18} className="mt-2.5 shrink-0 text-ink-secondary" />
            <div className="min-w-0 flex-1 space-y-2">
              <input ref={fileInput} type="file" multiple className="hidden" onChange={(event) => { void pickFiles(event.target.files); event.target.value = ""; }} />
              <button type="button" onClick={() => fileInput.current?.click()} className="rounded-lg border border-hairline/50 px-3 py-2 text-[12.5px] font-medium text-ink hover:bg-raised">Add attachment</button>
              <AttachmentChips attachments={attachments} onRemove={(id) => setAttachments((current) => current.filter((attachment) => attachment.id !== id))} />
              <div className="text-[11px] leading-relaxed text-ink-secondary">
                {kind === "routine"
                  ? "Attachments are passed to each local routine run and excluded from shared team files."
                  : selectedBots.length > 1
                    ? "References will be shared in the call when it starts."
                    : "References stay with the event and are available when you join the call."}
              </div>
              {attachmentNotice && <div className="text-[11.5px] text-warning">{attachmentNotice}</div>}
            </div>
          </div>
  );
  const runOnRow = kind === "routine" && !legacyTeamGoal && (
            <div className="flex items-start gap-4">
              <HIcon icon={LaptopIcon} size={18} className="mt-2.5 shrink-0 text-ink-secondary" />
              <div className="min-w-0 flex-1">
                <div className="rounded-xl border border-hairline/50 bg-inset p-3">
                  <div className="text-[12.5px] font-medium text-ink">Bot’s current setup</div>
                  <div className="mt-1 text-[11px] text-ink-secondary">Keeps its model and configured computer.</div>
                </div>
              </div>
            </div>
          );
  const headerTitle = !advanced && kind === "routine"
    ? t(existingRoutine ? "routines.editor.edit" : "routines.editor.new")
    : existingRoutine || existingCall ? "Edit event" : "New event";
  const repeatChoices = [
    ["none", "routines.repeat.once"],
    ["daily", "routines.repeat.daily"],
    ["weekdays", "routines.repeat.weekdays"],
    ["weekly", "routines.repeat.weekly"],
  ] as const;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-3 backdrop-blur-sm" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={existingRoutine || existingCall ? "Edit calendar event" : "Create calendar event"} tabIndex={-1} className="max-h-[94vh] w-full max-w-[760px] overflow-y-auto rounded-2xl border border-hairline/60 bg-panel shadow-2xl">
        <div className="sticky top-0 z-20 flex items-center justify-between border-b border-hairline/40 bg-panel/95 px-5 py-3.5 backdrop-blur">
          <div className="text-[15px] font-semibold text-ink">{headerTitle}</div>
          <button onClick={onClose} className="rounded-full p-2 text-ink-secondary hover:bg-raised hover:text-ink" aria-label="Close"><HIcon icon={MultiplicationSignIcon} size={18} /></button>
        </div>

        <div className="space-y-5 px-5 py-5 sm:px-8">
          {advanced && kindSwitchControl}

          {advanced && routineTypeControl}

          <div className="flex items-start gap-4">
            <span className="mt-3 size-4 shrink-0 rounded bg-accent" />
            <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder={kind === "routine" ? (advanced ? "Add title" : t("routines.editor.titlePlaceholder")) : "Add call title"} className="min-w-0 flex-1 border-b border-hairline/60 bg-transparent px-1 pb-2 text-[22px] font-medium text-ink outline-none placeholder:text-ink-tertiary focus:border-accent" />
          </div>

          {advanced ? (
            <div className="flex items-start gap-4">
              <HIcon icon={Clock03Icon} size={18} className="mt-2.5 shrink-0 text-ink-secondary" />
              <div className="min-w-0 flex-1 space-y-3">
                {whenControls}
                {repeatSelect}
                {scheduleNote}
                {repeatDetails}
                {runLimitControls}
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-4">
              <HIcon icon={Clock03Icon} size={18} className="mt-2.5 shrink-0 text-ink-secondary" />
              <div className="min-w-0 flex-1 space-y-3">
                <div className="text-[12.5px] font-medium text-ink">{t("routines.editor.when")}</div>
                {whenControls}
                <div role="group" aria-label={t("routines.editor.repeat")} className="flex flex-wrap gap-1.5">
                  {repeatChoices.map(([choice, label]) => (
                    <button
                      key={choice}
                      type="button"
                      aria-pressed={recurrence === choice}
                      onClick={() => selectRecurrence(choice)}
                      className={cn("rounded-full border px-3 py-1.5 text-[12px] font-medium transition", recurrence === choice ? "border-accent-border bg-accent/15 text-accent-text" : "border-hairline/50 bg-inset text-ink-secondary hover:bg-raised hover:text-ink")}
                    >
                      {t(label)}
                    </button>
                  ))}
                </div>
                {!repeatChoices.some(([choice]) => choice === recurrence) && <div className="text-[11.5px] text-ink-secondary">{t("routines.editor.customRepeat")}</div>}
              </div>
            </div>
          )}

          <div className="flex items-start gap-4">
            <HIcon icon={UserAdd01Icon} size={18} className="mt-2.5 shrink-0 text-ink-secondary" />
            <div className="min-w-0 flex-1">
              {legacyTeamGoal ? null : (
                <>
                  <div className="mb-2 text-[12.5px] font-medium text-ink">{kind === "routine" ? (advanced ? "Assign a bot" : t("routines.editor.who")) : "Add guests"}</div>
                  {bots.length > 0 ? (
                <>
                  <BotPicker bots={bots} selected={botIds} multiple={kind === "call"} locked={Boolean(lockedBotId || existingRoutine?.conversation)} onChange={selectBots} />
                  <div className="mt-2 text-[11.5px] text-ink-secondary">{kind === "routine" ? "This bot owns each scheduled run." : `${selectedBots.length || "No"} bot${selectedBots.length === 1 ? "" : "s"} invited to the call.`}</div>
                </>
              ) : (
                <button type="button" onClick={() => { dispatch({ type: "toggleNewBot", open: true }); onClose(); }} className="w-full rounded-xl border border-dashed border-accent/45 bg-accent/[0.06] px-4 py-4 text-left hover:bg-accent/10">
                  <div className="text-[12.5px] font-medium text-accent">Create your first bot</div>
                  <div className="mt-1 text-[11.5px] text-ink-secondary">A calendar event needs at least one bot.</div>
                </button>
                  )}
                </>
              )}
            </div>
          </div>

          {advanced && resultsControl}
          <div className="flex items-start gap-4">
            <HIcon icon={FileTextIcon} size={18} className="mt-2.5 shrink-0 text-ink-secondary" />
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={5} placeholder={kind === "routine" ? (advanced ? "Add instructions for the bot" : t("routines.editor.instructionsPlaceholder")) : "Add description or agenda"} className="min-w-0 flex-1 resize-y rounded-xl border border-hairline/50 bg-inset px-3.5 py-3 text-[13px] leading-relaxed text-ink outline-none placeholder:text-ink-tertiary focus:border-accent" />
          </div>
          {continuityControl}

          {advanced && attachmentsRow}

          {advanced && runOnRow}

          {!advanced && (
            <div>
              <button
                type="button"
                aria-expanded={moreOpen}
                aria-controls="routine-more-options"
                onClick={() => setMoreOpen((open) => !open)}
                className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12.5px] font-medium text-accent-text hover:bg-raised"
              >
                <HIcon icon={ChevronRightIcon} size={14} className={cn("transition-transform", moreOpen && "rotate-90")} />
                {t(moreOpen ? "routines.editor.fewer" : "routines.editor.more")}
              </button>
              {moreOpen && (
                <div id="routine-more-options" className="mt-3 space-y-5 rounded-xl border border-hairline/40 bg-inset/30 p-4">
                  {kindSwitchControl}
                  {routineTypeControl}
                  <div className="space-y-3">
                    {repeatSelect}
                    {scheduleNote}
                    {repeatDetails}
                    {runLimitControls}
                  </div>
                  {resultsControl}
                  {attachmentsRow}
                  {runOnRow}
                </div>
              )}
            </div>
          )}

          {error && <div className="ml-10 flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-[12.5px] text-danger"><HIcon icon={AlertCircleIcon} size={15} className="mt-0.5 shrink-0" />{error}</div>}
        </div>


        <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-hairline/40 bg-panel/95 px-5 py-3.5 backdrop-blur">
          <button onClick={onClose} className="rounded-lg px-4 py-2 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink">Cancel</button>
          <button onClick={save} disabled={saving || attachmentPending || !valid} className="flex items-center gap-2 rounded-lg bg-accent px-5 py-2 text-[12.5px] font-semibold text-white hover:brightness-110 disabled:opacity-40">{(saving || attachmentPending) && <HIcon icon={Loading02Icon} size={14} className="animate-spin" />}{attachmentPending ? "Attaching…" : existingRoutine || existingCall ? "Save" : kind === "call" ? "Schedule call" : "Schedule routine"}</button>
        </div>
      </div>
    </div>
  );
}

function QuickComposer({
  seed,
  bots,
  routinesOnly = false,
  onClose,
  onMore,
  onSavedRoutine,
  onSavedCall,
}: {
  seed: EventSeed;
  bots: Bot[];
  routinesOnly?: boolean;
  onClose: () => void;
  onMore: (seed: EventSeed) => void;
  onSavedRoutine: (routine: Routine) => void;
  onSavedCall: (call: CalendarCall) => void;
}) {
  const { dispatch } = useStore();
  const [kind, setKind] = useState<EventKind>(routinesOnly ? "routine" : seed.kind);
  const [name, setName] = useState(seed.name ?? "");
  const [description, setDescription] = useState(seed.description ?? "");
  const [botIds, setBotIds] = useState(seed.botIds.length ? seed.botIds : bots[0] ? [bots[0].id] : []);
  const [resultsThreadId, setResultsThreadId] = useState<string | null>(seed.resultsThreadId ?? null);
  const selectBots = (ids: string[]) => {
    if (ids[0] !== botIds[0]) setResultsThreadId(null);
    setBotIds(ids);
  };
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const [dialogPosition, setDialogPosition] = useState<{ left: number; top: number } | null>(null);
  const durationMinutes = kind === "routine" ? 30 : seed.durationMinutes;

  useLayoutEffect(() => {
    if (!seed.anchor) {
      setDialogPosition(null);
      return;
    }
    const dialog = dialogRef.current;
    if (!dialog) return;
    const place = () => {
      const gap = 12;
      const rect = dialog.getBoundingClientRect();
      let left = seed.anchor!.x + gap;
      let top = seed.anchor!.y + gap;
      if (left + rect.width > window.innerWidth - gap) left = seed.anchor!.x - rect.width - gap;
      if (top + rect.height > window.innerHeight - gap) top = seed.anchor!.y - rect.height - gap;
      setDialogPosition({
        left: Math.max(gap, Math.min(left, window.innerWidth - rect.width - gap)),
        top: Math.max(gap, Math.min(top, window.innerHeight - rect.height - gap)),
      });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [kind, seed.anchor]);

  const save = async () => {
    setWorking(true);
    setError("");
    try {
      if (kind === "routine" || routinesOnly) {
        const response = await api("/api/routines", {
          method: "POST",
          body: JSON.stringify({
            name,
            prompt: description,
            botId: botIds[0],
            runOn: "maus",
            enabled: true,
            schedule: { type: "once", at: seed.at },
            durationMinutes,
            attachments: [],
            resultsThreadId,
          } satisfies RoutineInput),
        });
        onSavedRoutine(response.routine);
      } else {
        const response = await api("/api/calendar-calls", {
          method: "POST",
          body: JSON.stringify({
            name,
            description,
            botIds,
            schedule: { type: "once", at: seed.at },
            durationMinutes,
          } satisfies CalendarCallInput),
        });
        onSavedCall(response.call);
      }
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  };

  const valid = Boolean(name.trim() && botIds.length && (kind === "call" || description.trim()));
  return (
    <div ref={dialogRef} role="dialog" aria-label="Quick create" style={dialogPosition ?? undefined} className={cn("fixed z-50 max-h-[calc(100vh-24px)] w-[min(430px,calc(100vw-24px))] overflow-y-auto rounded-2xl border border-hairline/60 bg-panel shadow-2xl", !dialogPosition && "left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2")}>
      <div className="flex items-center justify-between bg-raised/70 px-4 py-2.5">
        <div className="text-[12px] font-medium text-ink-secondary">New calendar event</div>
        <button onClick={onClose} className="rounded-full p-1.5 text-ink-secondary hover:bg-inset hover:text-ink" aria-label="Close"><HIcon icon={MultiplicationSignIcon} size={16} /></button>
      </div>
      <div className="space-y-3 p-4">
        <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Add title" onKeyDown={(event) => { if (event.key === "Enter" && valid) void save(); }} className="w-full border-b border-hairline/60 bg-transparent pb-2 text-[18px] font-medium text-ink outline-none placeholder:text-ink-tertiary focus:border-accent" />
        {!routinesOnly && (
          <div className="flex items-center gap-1 border-b border-hairline/35 pb-2">
            <button type="button" onClick={() => { setKind("routine"); setBotIds((ids) => ids.slice(0, 1)); }} className={cn("rounded-lg px-3 py-1.5 text-[12px] font-medium", kind === "routine" ? "bg-accent/15 text-accent" : "text-ink-secondary hover:bg-raised hover:text-ink")}>Routine</button>
            <button type="button" onClick={() => setKind("call")} className={cn("rounded-lg px-3 py-1.5 text-[12px] font-medium", kind === "call" ? "bg-accent/15 text-accent" : "text-ink-secondary hover:bg-raised hover:text-ink")}>Call</button>
          </div>
        )}
        <div className="flex items-start gap-3 text-[12.5px] text-ink">
          <HIcon icon={Clock03Icon} size={16} className="mt-0.5 shrink-0 text-ink-secondary" />
          <div><div>{niceDate(seed.at)}</div><div className="mt-0.5 text-ink-secondary">{niceTime(seed.at)}{kind === "call" ? ` – ${niceTime(seed.at + durationMinutes * 60_000)}` : ""}</div></div>
        </div>
        <div className="flex items-start gap-3">
          <HIcon icon={UserAdd01Icon} size={16} className="mt-2.5 shrink-0 text-ink-secondary" />
          {bots.length === 0 ? (
            <button type="button" onClick={() => { dispatch({ type: "toggleNewBot", open: true }); onClose(); }} className="min-w-0 flex-1 rounded-xl border border-dashed border-accent/45 bg-accent/[0.06] px-3 py-3 text-left hover:bg-accent/10">
              <div className="text-[12px] font-medium text-accent">Create your first bot</div>
              <div className="mt-0.5 text-[10.5px] text-ink-secondary">Then come back to schedule it.</div>
            </button>
          ) : kind === "routine" ? (
            <select value={botIds[0] ?? ""} onChange={(event) => selectBots([event.target.value])} className="min-w-0 flex-1 rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[12.5px] text-ink outline-none focus:border-accent">
              <option value="">Assign a bot</option>
              {bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
            </select>
          ) : (
            <div className="min-w-0 flex-1"><BotPicker bots={bots} selected={botIds} multiple onChange={selectBots} /></div>
          )}
        </div>
        <div className="flex items-start gap-3">
          <HIcon icon={FileTextIcon} size={16} className="mt-2.5 shrink-0 text-ink-secondary" />
          <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} placeholder={kind === "routine" ? "What should the bot do?" : "Add a description (optional)"} className="min-w-0 flex-1 resize-none rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[12.5px] leading-relaxed text-ink outline-none placeholder:text-ink-tertiary focus:border-accent" />
        </div>
        {kind === "routine" && <ResultsDestination bot={bots.find((bot) => bot.id === botIds[0])} value={resultsThreadId} onChange={(threadId) => setResultsThreadId(threadId ?? null)} />}
        {error && <div className="rounded-lg bg-danger/10 px-3 py-2 text-[11.5px] text-danger">{error}</div>}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-hairline/40 px-4 py-3">
        <button onClick={() => onMore({ ...seed, kind, botIds, name, description, durationMinutes, resultsThreadId })} title="Choose repeating schedules and other options" className="rounded-lg px-3 py-2 text-[12px] font-medium text-accent hover:bg-accent/10">More options</button>
        <button onClick={save} disabled={!valid || working} className="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-[12px] font-semibold text-white hover:brightness-110 disabled:opacity-40">{working && <HIcon icon={Loading02Icon} size={13} className="animate-spin" />}Save</button>
      </div>
    </div>
  );
}

function CalendarEventCard({
  item,
  bots,
  compact,
  layout,
  selected = false,
  onOpen,
  onResize,
}: {
  item: CalendarEventItem;
  bots: Bot[];
  compact: boolean;
  layout: { column: number; columns: number };
  selected?: boolean;
  onOpen: () => void;
  onResize: (minutes: number) => void;
}) {
  const isCall = item.kind === "call";
  const routine = item.kind === "routine" ? item.routine : null;
  const run = item.kind === "routine" ? item.run : null;
  // Legacy display only: the server still lists team goals stored before rooms
  // were retired. They are shown as unavailable and never run.
  const isRoomGoal = !isCall && (run?.target ?? routine?.target) === "room-goal";
  const ownerIds = isCall ? item.call.botIds : [run?.botId ?? routine?.botId ?? ""];
  const ownerBots = ownerIds.flatMap((id) => bots.find((bot) => bot.id === id) ?? []);
  const primary = ownerBots[0];
  const name = isCall ? item.call.name : run?.routineName ?? routine?.name ?? "Routine";
  // The bot's own colour tints the chip; calls and unknown bots use theme tokens.
  const color = isCall ? "var(--color-accent)" : primary ? MAUS_COLORS[primary.color] : "var(--color-ink-tertiary)";
  // A paused routine's projected occurrence: shown, but it will not run.
  const paused = Boolean(routine && !run && !routine.enabled);
  const [previewDuration, setPreviewDuration] = useState(item.durationMinutes);
  useEffect(() => setPreviewDuration(item.durationMinutes), [item.durationMinutes]);
  const status = run?.status;
  const statusLabel = run ? routineRunLabel(run) : undefined;
  const canMove = isCall || Boolean(routine && !run && !paused && routine.schedule.type !== "cron");
  const schedule = isCall ? item.call.schedule : routine?.schedule;
  const recurring = Boolean(schedule && schedule.type !== "once");
  const intervalCadence = schedule?.type === "interval" ? intervalLabel(schedule.everyMinutes) : null;

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const startY = event.clientY;
    const startDuration = previewDuration;
    let next = startDuration;
    const move = (pointer: PointerEvent) => {
      next = Math.max(CALENDAR_SLOT_MINUTES, Math.min(240, Math.round((startDuration + ((pointer.clientY - startY) / HOUR_HEIGHT) * 60) / CALENDAR_SLOT_MINUTES) * CALENDAR_SLOT_MINUTES));
      setPreviewDuration(next);
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      if (next === item.durationMinutes) return;
      if (recurring && !window.confirm("Resize this entire recurring series?")) {
        setPreviewDuration(item.durationMinutes);
        return;
      }
      onResize(next);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up, { once: true });
  };

  return (
    <button
      data-event-card
      type="button"
      draggable={canMove}
      title={routine?.schedule.type === "cron" ? "Open this routine to edit its repeating schedule and time zone." : undefined}
      onDragStart={(event) => {
        if (!canMove) return event.preventDefault();
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(EVENT_DRAG_TYPE, JSON.stringify({ kind: item.kind, id: isCall ? item.call.id : routine!.id, at: item.at }));
      }}
      onClick={(event) => { event.stopPropagation(); onOpen(); }}
      aria-pressed={selected}
      aria-label={`${name}, ${niceTime(item.at)}${paused ? `, ${t("routines.pausedSchedule")}` : statusLabel ? `, ${statusLabel}` : ""}`}
      className={cn(
        "group absolute z-10 overflow-hidden rounded-md border border-l-[3px] text-left transition hover:z-20 focus:z-20 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        previewDuration < 30 ? "px-1.5 py-0" : "px-1.5 py-1",
        paused && "border-dashed opacity-70",
        status === "cancelled" && "opacity-55",
        (status === "failed" || status === "missed") && "border-danger/60",
        selected && "z-20 ring-2 ring-accent ring-offset-1 ring-offset-app",
      )}
      style={{
        left: `calc(${(layout.column / layout.columns) * 100}% + 2px)`,
        width: `calc(${100 / layout.columns}% - 4px)`,
        top: `${((new Date(item.at).getHours() * 60 + new Date(item.at).getMinutes()) / 60) * HOUR_HEIGHT}px`,
        height: `${Math.max(16, (previewDuration / 60) * HOUR_HEIGHT)}px`,
        background: `color-mix(in srgb, ${color} ${paused ? 6 : 16}%, var(--color-card))`,
        borderColor: `color-mix(in srgb, ${color} 40%, transparent)`,
        borderLeftColor: color,
        color: `color-mix(in srgb, ${color} 55%, var(--color-ink))`,
      }}
    >
      <div className="flex min-w-0 items-start gap-1.5">
        {previewDuration >= 30 && (isCall ? <HIcon icon={Video01Icon} size={compact ? 11 : 13} className="mt-0.5 shrink-0" /> : primary ? <BotAvatar bot={primary} state={status ? statusState(status) : paused ? "sleeping" : "idle"} size={compact ? 18 : 22} animated={status === "running" || status === "waiting"} /> : null)}
        <div className="min-w-0 flex-1">
          <div className={cn("truncate text-[11px] font-semibold", previewDuration < 30 ? "leading-none" : "leading-tight")}>{name}</div>
          {previewDuration >= 30 && <div className="mt-0.5 truncate text-[9.5px] opacity-80">{niceTime(item.at)} · {paused ? t("routines.pausedSchedule") : intervalCadence ?? (isCall ? `${ownerBots.length} bot${ownerBots.length === 1 ? "" : "s"}` : isRoomGoal ? `Team goal · unavailable${statusLabel ? ` · ${statusLabel}` : ""}` : statusLabel ?? primary?.name)}</div>}
        </div>
        {previewDuration >= 30 && ownerBots.length > 1 && <span className="rounded bg-inset/60 px-1 py-0.5 text-[8px]">+{ownerBots.length - 1}</span>}
      </div>
      {isCall && <div onPointerDown={beginResize} className="absolute inset-x-1 bottom-0 h-1.5 cursor-ns-resize rounded-full opacity-0 transition group-hover:opacity-100" aria-label="Resize event"><div className="mx-auto mt-0.5 h-0.5 w-5 rounded-full bg-current opacity-50" /></div>}
    </button>
  );
}

function CalendarGrid({
  anchor,
  days,
  items,
  bots,
  selectedId,
  onOpen,
  onCreate,
  onMove,
  onResize,
}: {
  anchor: number;
  days: number;
  items: CalendarEventItem[];
  bots: Bot[];
  selectedId?: string;
  onOpen: (item: CalendarEventItem) => void;
  onCreate: (seed: EventSeed) => void;
  onMove: (item: { kind: EventKind; id: string; at: number }, nextAt: number) => void;
  onResize: (item: CalendarEventItem, duration: number) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<{ day: number; start: number; end: number } | null>(null);
  const [dragPreview, setDragPreview] = useState<{ day: number; at: number } | null>(null);
  const today = startOfDay(Date.now());
  const starts = Array.from({ length: days }, (_, index) => addDays(anchor, index));
  const minDayWidth = days === 7 ? 64 : days === 3 ? 180 : 280;
  const gridTemplateColumns = `64px repeat(${days}, minmax(${minDayWidth}px, 1fr))`;
  const minWidth = 64 + days * minDayWidth;

  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    const now = new Date();
    const hour = starts.includes(today) ? Math.max(0, now.getHours() - 2) : 7;
    viewport.scrollTo({ top: hour * HOUR_HEIGHT });
  }, [days]);

  const beginSelection = (event: ReactPointerEvent<HTMLDivElement>, day: number) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("[data-event-card]")) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const start = slotAt(day, event.clientY, rect.top, HOUR_HEIGHT);
    let end = start + 30 * 60_000;
    setSelection({ day, start, end });
    const move = (pointer: PointerEvent) => {
      const current = slotAt(day, pointer.clientY, rect.top, HOUR_HEIGHT);
      end = Math.max(start + CALENDAR_SLOT_MINUTES * 60_000, current + CALENDAR_SLOT_MINUTES * 60_000);
      setSelection({ day, start, end });
    };
    const up = (pointer: PointerEvent) => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      setSelection(null);
      onCreate({ kind: "routine", at: start, durationMinutes: Math.max(CALENDAR_SLOT_MINUTES, Math.round((end - start) / 60_000)), botIds: [], anchor: { x: pointer.clientX, y: pointer.clientY } });
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up, { once: true });
  };

  const drop = (event: ReactDragEvent<HTMLDivElement>, day: number) => {
    event.preventDefault();
    setDragPreview(null);
    const rect = event.currentTarget.getBoundingClientRect();
    const at = slotAt(day, event.clientY, rect.top, HOUR_HEIGHT);
    const botId = event.dataTransfer.getData(BOT_DRAG_TYPE);
    if (botId) return onCreate({ kind: "routine", at, durationMinutes: 30, botIds: [botId], anchor: { x: event.clientX, y: event.clientY } });
    const raw = event.dataTransfer.getData(EVENT_DRAG_TYPE);
    if (!raw) return;
    try {
      const item = JSON.parse(raw) as { kind: EventKind; id: string; at: number };
      onMove(item, at);
    } catch {
      // Ignore drags from another application.
    }
  };

  const previewDrop = (event: ReactDragEvent<HTMLDivElement>, day: number) => {
    if (!event.dataTransfer.types.includes(BOT_DRAG_TYPE) && !event.dataTransfer.types.includes(EVENT_DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = event.dataTransfer.types.includes(EVENT_DRAG_TYPE) ? "move" : "copy";
    const rect = event.currentTarget.getBoundingClientRect();
    const at = slotAt(day, event.clientY, rect.top, HOUR_HEIGHT);
    setDragPreview((current) => current?.day === day && current.at === at ? current : { day, at });
  };

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto border-l border-t border-hairline/40 bg-app">
      <div className="sticky top-0 z-30 grid bg-app/95 backdrop-blur" style={{ gridTemplateColumns, minWidth }}>
        <div className="border-b border-r border-hairline/40 px-2 py-3 text-center text-[9px] uppercase tracking-wider text-ink-secondary">{formatGmtOffset(-new Date(anchor).getTimezoneOffset())}</div>
        {starts.map((start) => {
          const date = new Date(start);
          const isToday = start === today;
          return <div key={start} role="columnheader" className={cn("border-b border-r border-hairline/40 px-2 py-2 text-center last:border-r-0", isToday && "bg-accent/[0.035]")}><div className={cn("text-[10px] font-medium uppercase tracking-[0.14em]", isToday ? "text-accent" : "text-ink-secondary")}>{DAY_NAMES[date.getDay()]}</div><div className={cn("mx-auto mt-1 flex size-8 items-center justify-center rounded-full text-[15px] font-medium", isToday ? "bg-accent text-accent-ink" : "text-ink")}>{date.getDate()}</div></div>;
        })}
      </div>
      <div role="grid" aria-label="Routine and call calendar" onDragEnd={() => setDragPreview(null)} className="relative grid" style={{ height: HOUR_HEIGHT * 24, gridTemplateColumns, minWidth }}>
        <div className="relative border-r border-hairline/40">
          {Array.from({ length: 24 }, (_, hour) => <div key={hour} className="absolute right-2 -translate-y-1/2 text-[9.5px] tabular-nums text-ink-tertiary" style={{ top: hour * HOUR_HEIGHT }}>{hour === 0 ? "" : new Date(2000, 0, 1, hour).toLocaleTimeString([], { hour: "numeric" })}</div>)}
        </div>
        {starts.map((start) => {
          const now = new Date();
          const nowTop = ((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_HEIGHT;
          const dayItems = items.filter((item) => startOfDay(item.at) === start);
          const collisionLayouts = packCalendarCollisions(dayItems);
          const selected = selection?.day === start ? selection : null;
          const preview = dragPreview?.day === start ? dragPreview : null;
          return (
            <div key={start} role="gridcell" aria-label={`${niceDate(start)} calendar`} onPointerDown={(event) => beginSelection(event, start)} onDragOver={(event) => previewDrop(event, start)} onDragLeave={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragPreview(null); }} onDrop={(event) => drop(event, start)} className={cn("relative border-r border-hairline/40 last:border-r-0", start === today && "bg-accent/[0.025]")}>
              {Array.from({ length: 48 }, (_, half) => <div key={half} className={cn("pointer-events-none absolute inset-x-0 border-t", half % 2 === 0 ? "border-hairline/30" : "border-hairline/10")} style={{ top: (half / 2) * HOUR_HEIGHT }} />)}
              {start === today && <div className="pointer-events-none absolute inset-x-0 z-20 flex items-center" style={{ top: nowTop }}><span className="-ml-1 size-2 rounded-full bg-danger" /><span className="h-px flex-1 bg-danger/80" /></div>}
              {selected && <div className="pointer-events-none absolute inset-x-1 z-10 rounded-md border border-accent/70 bg-accent/20" style={{ top: ((new Date(selected.start).getHours() * 60 + new Date(selected.start).getMinutes()) / 60) * HOUR_HEIGHT, height: Math.max(16, ((selected.end - selected.start) / 3_600_000) * HOUR_HEIGHT) }} />}
              {preview && <div className="pointer-events-none absolute inset-x-1 z-20 rounded-md border border-accent/80 bg-accent/25 shadow-sm" style={{ top: ((new Date(preview.at).getHours() * 60 + new Date(preview.at).getMinutes()) / 60) * HOUR_HEIGHT, height: HOUR_HEIGHT / 2 }}><div className="px-2 py-1 text-[9.5px] font-medium text-accent">{niceTime(preview.at)}</div></div>}
              {dayItems.map((item) => <CalendarEventCard key={item.id} item={item} bots={bots} compact={days === 7} layout={collisionLayouts.get(item.id) ?? { column: 0, columns: 1 }} selected={item.id === selectedId} onOpen={() => onOpen(item)} onResize={(minutes) => onResize(item, minutes)} />)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function EventDetails({
  item,
  bots,
  onClose,
  onEdit,
  onCallChanged,
  onOpenChat,
  onOpenRun,
}: {
  item: CalendarEventItem;
  bots: Bot[];
  onClose: () => void;
  onEdit: () => void;
  onCallChanged: (id: string | null) => void;
  onOpenChat: (id: string) => void;
  /** Opens one of the routine's recent runs in this drawer. */
  onOpenRun?: (run: RoutineRun) => void;
}) {
  const { state, dispatch } = useStore();
  const advanced = useAdvancedMode();
  const [working, setWorking] = useState(false);
  const runNowPending = useRef(false);
  const [starting, setStarting] = useState(false);
  // undefined preserves the selected historical run; null clears it for a new attempt.
  const [submittedRun, setSubmittedRun] = useState<RoutineRun | null | undefined>(undefined);
  const [error, setError] = useState("");
  const isCall = item.kind === "call";
  const routine = item.kind === "routine" ? item.routine : null;
  const run = submittedRun === undefined
    ? item.kind === "routine" ? item.run : null
    : submittedRun && (state.routineRuns.find((candidate) => candidate.id === submittedRun.id) ?? submittedRun);
  const call = item.kind === "call" ? item.call : null;
  // Legacy display only: the server still lists team goals stored before rooms
  // were retired. They are shown as unavailable and never run.
  const isRoomGoal = !isCall && (run?.target ?? routine?.target) === "room-goal";
  const executionThreadId = run?.executionThreadId ?? run?.threadId;
  const botIds = call?.botIds ?? [run?.botId ?? routine?.botId ?? ""];
  const invited = botIds.flatMap((id) => bots.find((bot) => bot.id === id) ?? []);
  const primary = invited[0];
  // A stored team goal's thread belonged to a retired room, so it cannot be opened.
  const executionOwner = isRoomGoal ? undefined : primary;
  const canOpenExecution = Boolean(executionThreadId && !executionOwner?.tasks?.find((task) => task.threadId === executionThreadId)?.forConversation && (executionOwner?.threadId === executionThreadId || executionOwner?.tasks?.some((task) => task.threadId === executionThreadId)));
  // A run snapshots where it reported (older runs: the chat that made the
  // routine). A routine without a chosen thread reports to the main thread.
  const conversation = run?.conversation ?? routine?.conversation;
  const resultsThreadId = conversation?.threadId ?? (run ? run.resultsThreadId ?? run.sourceThreadId : routine?.resultsThreadId);
  const canOpenResults = resultsThreadId && (Boolean(conversation?.id) || state.bots.some((owner) => owner.threadId === resultsThreadId || owner.tasks?.some((task) => task.threadId === resultsThreadId)));
  const title = call?.name ?? run?.routineName ?? routine?.name ?? "Routine";
  const description = call?.description ?? run?.prompt ?? routine?.prompt ?? "";
  const attachments = call?.attachments ?? run?.attachments ?? routine?.attachments ?? [];
  const chatBotId = call?.botIds.length === 1 ? primary?.id : undefined;
  const safetyLimit = run ? run.timeoutMinutes : routine?.timeoutMinutes;

  const openRunTask = () => {
    if (!executionThreadId) return;
    if (primary) {
      dispatch({ type: "select", id: primary.id });
      dispatch({ type: "switchTask", botId: primary.id, threadId: executionThreadId });
    }
    onClose();
  };

  const invoke = async (path: string, method = "POST", body?: unknown) => {
    setWorking(true);
    setError("");
    try {
      const response = await api(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (response.routine) dispatch({ type: "routinePatched", routine: response.routine });
      if (response.run) dispatch({ type: "routineRunPatched", run: response.run });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  };

  const runRoutineNow = () => {
    if (!routine || working || runNowPending.current) return;
    runNowPending.current = true;
    setStarting(true);
    setSubmittedRun(null);
    setWorking(true);
    setError("");
    // The store flushes pending model and approval-level changes before it
    // starts the run. Keep this button pending through that barrier and the
    // POST so a double-click cannot create two routine runs.
    dispatch({
      type: "runRoutine",
      routineId: routine.id,
      // Prefer subsequent SSE records over this response, which may already be stale.
      onStarted: setSubmittedRun,
      onError: (cause) => setError(cause instanceof Error ? cause.message : String(cause)),
      onSettled: () => {
        runNowPending.current = false;
        setStarting(false);
        setWorking(false);
      },
    });
  };

  const deleteEvent = async () => {
    if (!window.confirm(`Delete “${title}”?`)) return;
    if (call) {
      await api(`/api/calendar-calls/${call.id}`, { method: "DELETE" });
      onCallChanged(call.id);
    } else if (routine) {
      dispatch({ type: "deleteRoutine", routineId: routine.id });
    }
    onClose();
  };

  const routineId = routine?.id ?? run?.routineId;
  const recentRuns = routineId
    ? state.routineRuns.filter((candidate) => candidate.routineId === routineId)
      .sort((left, right) => routineRunTime(right) - routineRunTime(left))
      .slice(0, 3)
    : [];
  const runOn = run?.runOn ?? routine?.runOn;
  const runsOn = routineRunsOn({ runOn, computer: primary?.computer });
  const resultsOwner = resultsThreadId
    ? state.bots.find((owner) => owner.threadId === resultsThreadId || owner.tasks?.some((task) => task.threadId === resultsThreadId))
    : undefined;
  const resultsTitle = conversation?.id ? "Conversation where this was scheduled" : !resultsThreadId
    ? t("routines.results.main")
    : resultsOwner?.tasks?.find((task) => task.threadId === resultsThreadId)?.title ?? resultsOwner?.name ?? t("routines.results.missing");

  return (
    <aside aria-label={t("routines.drawer.label")} className="flex h-full w-[min(310px,100vw)] shrink-0 flex-col border-l border-hairline/40 bg-panel">
      <div className="flex items-start gap-3 border-b border-hairline/40 px-4 py-3.5">
        {isCall
          ? <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent-text"><HIcon icon={Video01Icon} size={16} /></span>
          : isRoomGoal
            ? <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent-text"><HIcon icon={UsersIcon} size={16} /></span>
            : primary && <BotAvatar bot={primary} state={run ? statusState(run.status) : routine?.enabled === false ? "sleeping" : "idle"} size={36} animated={false} />}
        <div className="min-w-0 flex-1">
          <div className="break-words text-[15px] font-semibold leading-snug text-ink">{title}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {routine && <span className={cn("rounded-full px-2 py-0.5 text-[10.5px] font-medium", routine.enabled ? "bg-success/15 text-success" : "bg-inset text-ink-secondary")}>{routineScheduleState(routine)}</span>}
            <span className="text-[11px] text-ink-secondary">{niceDate(item.at)} · {niceTime(item.at)}{isCall ? ` – ${niceTime(item.at + item.durationMinutes * 60_000)}` : ""}</span>
          </div>
        </div>
        <button type="button" onClick={onClose} className="rounded-full p-1.5 text-ink-secondary hover:bg-raised hover:text-ink" aria-label={t("routines.drawer.close")}><HIcon icon={MultiplicationSignIcon} size={16} /></button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {run && <div role="status" aria-live="polite" className="rounded-xl border border-hairline/40 bg-inset p-3"><div className="flex items-center gap-2 text-[12px] font-medium text-ink">{run.status === "running" && <HIcon icon={Loading02Icon} size={13} className="animate-spin text-accent" />}{routineRunLabel(run)}</div>{run.output && <div className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap text-[11.5px] leading-relaxed text-ink-secondary">{run.output}</div>}{run.error && <div className="mt-2 text-[11.5px] text-danger">{run.error}</div>}</div>}
        {run?.attention && <div className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2.5 text-warning"><HIcon icon={AlertCircleIcon} size={15} className="mt-0.5 shrink-0" /><div className="min-w-0 whitespace-pre-wrap text-[11.5px] leading-relaxed">{run.attention}</div></div>}
        {run?.status === "waiting" && !run.attention && <div className="rounded-xl border border-warning/30 bg-warning/10 px-3 py-2.5 text-[11.5px] text-warning">This run is waiting. Open its execution thread for more context.</div>}

        <DrawerField label={isCall ? t("routines.drawer.guests") : t("routines.drawer.bot")}>
          <div className="flex flex-wrap gap-1.5">
            {invited.map((bot) => <div key={bot.id} className="flex items-center gap-1.5 rounded-full border border-hairline/50 bg-inset py-0.5 pl-0.5 pr-2.5"><BotAvatar bot={bot} state="idle" size={22} animated={false} /><span className="text-[12px] text-ink">{bot.name}</span></div>)}
            {invited.length === 0 && <span className="text-[12.5px] text-ink-secondary">{t("routines.unavailableBot")}</span>}
          </div>
        </DrawerField>
        {(routine || call) && (
          <DrawerField label={t("routines.drawer.schedule")}>
            <div className="text-[12.5px] text-ink">{scheduleLabel((routine ?? call)!.schedule)}</div>
            {routine?.schedule.type === "cron" && <div className="mt-2"><CronSchedulePreview schedule={routine.schedule} paused={!routine.enabled} /></div>}
          </DrawerField>
        )}
        {description && <DrawerField label={isCall ? t("routines.drawer.agenda") : t("routines.drawer.what")}><div className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink">{description}</div></DrawerField>}
        {!isCall && !isRoomGoal && (
          <DrawerField label={t("routines.drawer.runsOn")}>
            <div className="flex items-start gap-2 text-[12.5px] text-ink"><HIcon icon={LaptopIcon} size={14} className="mt-0.5 shrink-0 text-ink-secondary" /><span>{runsOn.label}</span></div>
            <div className="mt-0.5 text-[11px] leading-relaxed text-ink-secondary">{runsOn.hint}</div>
          </DrawerField>
        )}
        {!isCall && !isRoomGoal && <DrawerField label={t("routines.results.label")}><div className="text-[12.5px] text-ink">{resultsTitle}</div></DrawerField>}
        {attachments.length > 0 && <DrawerField label="Attachments"><AttachmentChips attachments={attachments} />{call && <div className="mt-1.5 text-[11px] leading-relaxed text-ink-secondary">{call.botIds.length > 1 ? "These references will be shared in the call when it starts." : "These references stay with the event and are available when you join the call."}</div>}</DrawerField>}
        {advanced && !isCall && <DrawerField label={t("routines.drawer.runLimit")}><div className="text-[12.5px] text-ink">{safetyLimit == null ? "No time limit" : `Stops if still running after ${durationLabel(safetyLimit)}`}</div></DrawerField>}
        {!isCall && (
          <DrawerField label={t("routines.logs")} action={routine && <button type="button" onClick={() => { dispatch({ type: "showRoutines", section: "logs", routineId: routine.id, botId: routine.botId }); onClose(); }} className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-accent-text hover:bg-raised"><HIcon icon={FileTextIcon} size={11} />{t("routines.drawer.allRuns")}</button>}>
            {recentRuns.length === 0
              ? <div className="text-[12px] text-ink-secondary">{t("routines.drawer.noRuns")}</div>
              : <div className="space-y-1">{recentRuns.map((recent) => <RecentRunRow key={recent.id} run={recent} current={recent.id === run?.id} onOpen={() => onOpenRun?.(recent)} />)}</div>}
          </DrawerField>
        )}
        {error && <div role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-[11.5px] text-danger">{error}</div>}
      </div>

      <div className="space-y-2 border-t border-hairline/40 px-4 py-3">
        {routine && (
          <div className="flex items-center gap-2">
            <button onClick={runRoutineNow} disabled={working} className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[12px] font-semibold text-accent-ink hover:brightness-110 disabled:opacity-50">{starting ? <HIcon icon={Loading02Icon} size={13} className="animate-spin" /> : <HIcon icon={PlayIcon} size={13} />}{starting ? t("routines.starting") : t("routines.runNow")}</button>
            <button disabled={working} onClick={() => void invoke(`/api/routines/${routine.id}`, "PATCH", { enabled: !routine.enabled })} title={routine.enabled ? "Pause routine" : "Resume routine"} className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-hairline/50 bg-control px-3 py-2 text-[12px] font-medium text-ink hover:bg-raised-hover disabled:opacity-40">{routine.enabled ? <HIcon icon={PauseIcon} size={13} /> : <HIcon icon={PlayIcon} size={13} />}{routine.enabled ? t("routines.pause") : t("routines.resume")}</button>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-1">
          {chatBotId && <button onClick={() => onOpenChat(chatBotId)} className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[12px] font-semibold text-accent-ink hover:brightness-110"><HIcon icon={SquareArrowUpRightIcon} size={13} />Open chat</button>}
          {canOpenExecution && <button onClick={openRunTask} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink"><HIcon icon={SquareArrowUpRightIcon} size={13} />Open thread</button>}
          {canOpenResults && resultsThreadId && <button type="button" onClick={() => { if (conversation?.id) dispatch({ type: "selectConversation", id: conversation.id }); else openNotificationTarget(dispatch, { botId: botIds[0], threadId: resultsThreadId }, state); onClose(); }} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink"><HIcon icon={SquareArrowUpRightIcon} size={13} />{t("routines.results.open")}</button>}
          {run && ["queued", "running", "waiting"].includes(run.status) && <button onClick={() => void invoke(`/api/routine-runs/${run.id}/cancel`)} disabled={working} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40"><HIcon icon={MultiplicationSignIcon} size={13} />Cancel run</button>}
          <div className="ml-auto flex items-center gap-1">
            {(routine || call) && <button onClick={onEdit} className="rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-ink hover:bg-raised">{t("routines.edit")}</button>}
            {(routine || call) && <button onClick={() => void deleteEvent()} className="rounded-lg p-2 text-ink-secondary hover:bg-danger/10 hover:text-danger" title={t("routines.delete")} aria-label={t("routines.delete")}><HIcon icon={Delete02Icon} size={14} /></button>}
          </div>
        </div>
      </div>
    </aside>
  );
}

function DrawerField({ label, action, children }: { label: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <h3 className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-tertiary">{label}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function runDurationLabel(run: RoutineRun): string | null {
  if (run.startedAt == null || run.finishedAt == null || run.finishedAt < run.startedAt) return null;
  const seconds = Math.round((run.finishedAt - run.startedAt) / 1_000);
  if (seconds < 60) return `${seconds}s`;
  return durationLabel(Math.round(seconds / 60));
}

function RecentRunRow({ run, current, onOpen }: { run: RoutineRun; current: boolean; onOpen: () => void }) {
  const at = run.startedAt ?? run.scheduledFor;
  const duration = runDurationLabel(run);
  const ok = run.status === "completed" && (!run.goalStatus || run.goalStatus === "completed");
  const problem = isRoutineProblemRun(run) || run.goalStatus === "failed" || run.goalStatus === "blocked";
  const active = ["queued", "running", "waiting"].includes(run.status);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t("routines.openRun", { name: run.routineName, status: routineRunLabel(run) })}
      aria-current={current || undefined}
      className={cn("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-raised", current && "bg-raised")}
    >
      {ok
        ? <HIcon icon={CheckmarkCircle02Icon} size={14} className="shrink-0 text-success" aria-hidden="true" />
        : problem
          ? <HIcon icon={CancelCircleIcon} size={14} className="shrink-0 text-danger" aria-hidden="true" />
          : active
            ? <HIcon icon={Loading02Icon} size={14} className="shrink-0 animate-spin text-accent" aria-hidden="true" />
            : <HIcon icon={AlertCircleIcon} size={14} className="shrink-0 text-ink-tertiary" aria-hidden="true" />}
      <span className="min-w-0 flex-1 truncate text-[12px] text-ink">{new Date(at).toLocaleDateString([], { month: "short", day: "numeric" })}</span>
      <span className="shrink-0 text-[11px] tabular-nums text-ink-secondary">{niceTime(at)}{duration ? ` · ${duration}` : ""}</span>
    </button>
  );
}

export function PausedList({
  routines,
  bots,
  onClose,
  onEdit,
}: {
  routines: Routine[];
  bots: Bot[];
  onClose: () => void;
  onEdit: (routine: Routine) => void;
}) {
  const { dispatch } = useStore();
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalDialog(dialogRef, onClose);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Paused routines" tabIndex={-1} className="w-full max-w-[520px] rounded-2xl border border-hairline/60 bg-panel shadow-2xl">
        <div className="flex items-center justify-between border-b border-hairline/40 px-5 py-4"><div><div className="text-[16px] font-semibold text-ink">Paused routines</div><div className="mt-0.5 text-[11.5px] text-ink-secondary">History is kept; no new tasks will run.</div></div><button onClick={onClose} className="rounded-full p-2 text-ink-secondary hover:bg-raised" aria-label={t("routines.paused.close")}><HIcon icon={MultiplicationSignIcon} size={17} /></button></div>
        <div className="max-h-[55vh] space-y-1 overflow-y-auto p-3">
          {routines.map((routine) => {
            const bot = bots.find((candidate) => candidate.id === routine.botId);
            // Team goals were retired with rooms: shown, never resumed.
            const roomGoal = routine.target === "room-goal";
            return (
              <div key={routine.id} className="flex items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-raised/60">
                {roomGoal ? <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent/12 text-accent"><HIcon icon={UsersIcon} size={17} /></span> : bot && <BotAvatar bot={bot} state="sleeping" size={36} animated={false} />}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12.5px] font-medium text-ink">{routine.name}</div>
                  <div className="mt-0.5 truncate text-[10.5px] text-ink-secondary">{roomGoal ? "Team goal · unavailable · " : ""}{scheduleLabel(routine.schedule)}</div>
                </div>
                {!roomGoal && <button onClick={() => dispatch({ type: "updateRoutine", routineId: routine.id, patch: { enabled: true } })} className="rounded-lg bg-accent/15 px-2.5 py-1.5 text-[11px] font-medium text-accent">Resume</button>}
                <button onClick={() => onEdit(routine)} className="rounded-lg px-2 py-1.5 text-[11px] text-ink-secondary hover:bg-inset">Edit</button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function RoutineEditor({
  routine,
  bots,
  lockedBotId,
  defaultRunOn,
  onClose,
}: {
  routine?: Routine;
  bots: Bot[];
  lockedBotId?: string;
  defaultRunOn?: RoutineRunOn;
  onClose: () => void;
}) {
  const at = routine?.schedule.type === "once"
    ? routine.schedule.at
    : routine?.schedule.type === "daily"
      ? atLocalTime(Date.now(), routine.schedule.time)
      : routine?.schedule.type === "interval"
        ? routine.schedule.anchorAt
      : routine?.schedule.type === "cron"
        ? routine.nextRunAt ?? nextHour()
      : nextHour();
  return <EventEditor seed={{ kind: "routine", at, durationMinutes: routine?.durationMinutes ?? 30, botIds: lockedBotId ? [lockedBotId] : routine ? [routine.botId] : [], routine }} bots={bots} lockedBotId={lockedBotId} defaultRunOn={defaultRunOn} onClose={onClose} onSavedCall={() => {}} />;
}

export function RoutinesPage({ onBack, onOpenChat }: { onBack: () => void; onOpenChat: (id: string) => void }) {
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const advanced = useAdvancedMode();
  const routinesOnly = window.colonie?.remoteClient?.active === true;
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const [section, setSection] = useState<"calendar" | "logs" | "webhooks">(state.routinesFocus?.section === "logs" ? "logs" : "calendar");
  const [layout, setLayout] = useState<RoutinesLayout>(state.routinesFocus?.view === "list" ? "list" : "week");
  const [anchor, setAnchor] = useState(() => startOfDay(Date.now()));
  const [botFilter, setBotFilter] = useState(state.routinesFocus?.botId ?? "all");
  const [routineFilter, setRoutineFilter] = useState<string | undefined>(state.routinesFocus?.routineId);
  const [statusFilter, setStatusFilter] = useState<RoutineRunStatusFilter>(state.routinesFocus?.runStatus ?? "all");
  const [calls, setCalls] = useState<CalendarCall[]>([]);
  const [quick, setQuick] = useState<EventSeed | null>(null);
  const [editor, setEditor] = useState<EventSeed | null>(null);
  const [selected, setSelected] = useState<CalendarEventItem | null>(null);
  const [pausedOpen, setPausedOpen] = useState(false);
  const [webhookCreateRequest, setWebhookCreateRequest] = useState(0);
  const [error, setError] = useState("");
  const visibleBots = state.bots.filter((bot) => !bot.hidden);
  // Webhooks are an Advanced-mode tool; Simple mode keeps triggers elsewhere.
  const webhooksAvailable = advanced && !routinesOnly;
  const shownSection = section === "webhooks" && !webhooksAvailable ? "calendar" : section;
  const viewDays = layout === "day" ? 1 : 7;
  const rangeStart = viewDays === 7 ? startOfWeek(anchor) : startOfDay(anchor);
  const rangeEnd = addDays(rangeStart, viewDays);
  const datedView = shownSection === "calendar" && layout !== "list";

  useEffect(() => {
    const focus = state.routinesFocus;
    setSection(focus?.section === "logs" ? "logs" : "calendar");
    setLayout(focus?.view === "list" ? "list" : "week");
    setBotFilter(focus?.botId ?? "all");
    setRoutineFilter(focus?.routineId);
    setStatusFilter(focus?.runStatus ?? "all");
  }, [state.routinesFocus]);

  const loadCalls = useCallback(async () => {
    try {
      const response = await api("/api/calendar-calls");
      setCalls(response.calls ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);
  useEffect(() => {
    if (!routinesOnly) void loadCalls();
  }, [loadCalls, routinesOnly]);
  useEffect(() => { backButtonRef.current?.focus({ preventScroll: true }); }, []);

  const items = useMemo<CalendarEventItem[]>(() => {
    const routineItems = projectedRoutineItems(state.routines, state.routineRuns, rangeStart, rangeEnd).map((item) => ({ ...item, kind: "routine" as const }));
    // Paused routines keep their place on the grid, muted, so they are easy
    // to find and resume. Only upcoming slots: a paused slot never ran.
    const now = Date.now();
    const pausedRoutines = state.routines.filter((routine) => !routine.enabled);
    const pausedItems = projectedRoutineItems(pausedRoutines.map((routine) => ({ ...routine, enabled: true })), state.routineRuns, rangeStart, rangeEnd)
      .filter((item) => !item.run && item.at >= now)
      .map((item) => ({
        ...item,
        id: `paused-${item.id}`,
        routine: pausedRoutines.find((routine) => routine.id === item.routine?.id) ?? item.routine,
        kind: "routine" as const,
      }));
    const callItems = projectCalls(calls, rangeStart, rangeEnd).map((item) => ({ ...item, kind: "call" as const }));
    return [...routineItems, ...pausedItems, ...callItems]
      .filter((item) => botFilter === "all" || (item.kind === "call" ? item.call.botIds.includes(botFilter) : (item.routine?.botId ?? item.run?.botId) === botFilter))
      .sort((left, right) => left.at - right.at);
  }, [state.routines, state.routineRuns, calls, rangeStart, rangeEnd, botFilter]);

  const liveSelected = selected?.kind === "call"
    ? (() => { const call = calls.find((candidate) => candidate.id === selected.call.id); return call ? { ...selected, call } : null; })()
    : selected?.kind === "routine"
      ? {
          ...selected,
          routine: selected.routine ? state.routines.find((routine) => routine.id === selected.routine?.id) ?? null : null,
          run: selected.run ? state.routineRuns.find((run) => run.id === selected.run?.id) ?? selected.run : null,
        }
      : null;
  const paused = state.routines.filter((routine) => !routine.enabled && (routine.schedule.type !== "once" || routine.schedule.at > Date.now()));
  const running = state.routineRuns.filter((run) => ["queued", "running", "waiting"].includes(run.status)).length;
  const unseenFailures = state.routineRuns.filter((run) => isRoutineProblemRun(run) && !run.seenAt).length;
  const filteredRoutines = state.routines.filter((routine) => botFilter === "all" || routine.botId === botFilter);
  const filteredRuns = state.routineRuns.filter((run) => botFilter === "all" || run.botId === botFilter);
  const routineAt = (routine: Routine) => routine.schedule.type === "once"
    ? routine.schedule.at
    : routine.schedule.type === "interval"
      ? routine.schedule.anchorAt
      : routine.schedule.type === "cron"
        ? routine.nextRunAt ?? nextHour()
        : atLocalTime(Date.now(), routine.schedule.time);
  const openRoutine = (routine: Routine) => setSelected({ kind: "routine", id: routine.id, at: routine.nextRunAt ?? routineAt(routine), durationMinutes: routine.durationMinutes, routine, run: null });
  const openLogs = (routine: Routine) => { setRoutineFilter(routine.id); setSection("logs"); };
  const openRun = (run: RoutineRun) => {
    setSelected({ kind: "routine", id: run.id, at: run.scheduledFor, durationMinutes: run.durationMinutes ?? 30, routine: state.routines.find((routine) => routine.id === run.routineId) ?? null, run });
    if (["failed", "missed"].includes(run.status) && !run.seenAt) dispatch({ type: "markRoutineRunSeen", runId: run.id });
  };
  const openItem = (item: CalendarEventItem) => {
    setSelected(item);
    if (item.kind === "routine" && item.run && ["failed", "missed"].includes(item.run.status) && !item.run.seenAt) dispatch({ type: "markRoutineRunSeen", runId: item.run.id });
  };
  const macInset = capabilities.windowChrome === "mac-inset";
  const windowDragStyle = macInset
    ? ({ WebkitAppRegion: "drag" } as CSSProperties)
    : undefined;
  const windowNoDragStyle = macInset
    ? ({ WebkitAppRegion: "no-drag" } as CSSProperties)
    : undefined;

  const showLayout = (next: RoutinesLayout) => {
    setSection("calendar");
    setLayout(next);
    setAnchor((current) => startOfDay(current));
  };
  const goToday = useCallback(() => setAnchor(startOfDay(Date.now())), []);
  const handleWebhookCreateHandled = useCallback(() => setWebhookCreateRequest(0), []);
  const openCreate = useCallback((seed?: Partial<EventSeed>) => {
    setSelected(null);
    setQuick({ kind: "routine", at: nextHour(), durationMinutes: 30, botIds: [], ...seed });
  }, []);
  // Advanced keeps the quick popover (with its Routine / Call switch); Simple
  // goes straight to the plain editor, which has a time and Repeat choices.
  const createRoutine = () => {
    if (section === "webhooks") setSection("calendar");
    if (advanced) return openCreate({ kind: "routine" });
    setSelected(null);
    setEditor({ kind: "routine", at: nextHour(), durationMinutes: 30, botIds: botFilter !== "all" ? [botFilter] : [] });
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable=true]")) return;
      if (event.key === "Escape") { setQuick(null); setEditor(null); setSelected(null); return; }
      if (shownSection !== "calendar" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.toLowerCase() === "c") { event.preventDefault(); openCreate(); }
      if (event.key.toLowerCase() === "t") goToday();
      if (event.key === "1" || event.key.toLowerCase() === "d") showLayout("day");
      if (event.key.toLowerCase() === "w") showLayout("week");
      if (event.key.toLowerCase() === "l") showLayout("list");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shownSection, openCreate, goToday, anchor]);

  const upsertCall = (call: CalendarCall) => setCalls((current) => current.some((candidate) => candidate.id === call.id) ? current.map((candidate) => candidate.id === call.id ? call : candidate) : [call, ...current]);
  const moveEvent = async (dragged: { kind: EventKind; id: string; at: number }, nextAt: number) => {
    if (nextAt === dragged.at) return;
    try {
      if (dragged.kind === "routine") {
        const routine = state.routines.find((candidate) => candidate.id === dragged.id);
        if (!routine) return;
        if (routine.schedule.type === "cron") throw new Error("Open this routine to edit its repeating schedule and time zone.");
        if (routine.schedule.type !== "once" && !window.confirm("Move this entire recurring series?")) return;
        const response = await api(`/api/routines/${routine.id}`, { method: "PATCH", body: JSON.stringify({ schedule: scheduleAt(routine.schedule, dragged.at, nextAt) }) });
        dispatch({ type: "routinePatched", routine: response.routine });
      } else {
        const call = calls.find((candidate) => candidate.id === dragged.id);
        if (!call) return;
        if (call.schedule.type === "daily" && !window.confirm("Move this entire recurring series?")) return;
        const response = await api(`/api/calendar-calls/${call.id}`, { method: "PATCH", body: JSON.stringify({ schedule: scheduleAt(call.schedule, dragged.at, nextAt) }) });
        upsertCall(response.call);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const resizeEvent = async (item: CalendarEventItem, durationMinutes: number) => {
    try {
      if (item.kind === "routine" && item.routine) {
        const response = await api(`/api/routines/${item.routine.id}`, { method: "PATCH", body: JSON.stringify({ durationMinutes }) });
        dispatch({ type: "routinePatched", routine: response.routine });
      } else if (item.kind === "call") {
        const response = await api(`/api/calendar-calls/${item.call.id}`, { method: "PATCH", body: JSON.stringify({ durationMinutes }) });
        upsertCall(response.call);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const editSelected = () => {
    if (!liveSelected) return;
    const seed: EventSeed = liveSelected.kind === "call"
      ? { kind: "call", at: liveSelected.at, durationMinutes: liveSelected.call.durationMinutes, botIds: liveSelected.call.botIds, call: liveSelected.call }
      : { kind: "routine", at: liveSelected.at, durationMinutes: liveSelected.routine?.durationMinutes ?? liveSelected.run?.durationMinutes ?? 30, botIds: [liveSelected.routine?.botId ?? liveSelected.run?.botId ?? ""].filter(Boolean), routine: liveSelected.routine ?? undefined };
    setSelected(null);
    setEditor(seed);
  };
  const segment = (active: boolean) => cn("flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium", active ? "bg-raised text-ink shadow-sm" : "text-ink-secondary hover:text-ink");
  const drawerOpen = Boolean(liveSelected) && shownSection !== "webhooks";

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-app animate-workspace-in">
      <header
        className={cn("shrink-0 border-b border-hairline/35 bg-app py-3 pr-4", macInset ? "pl-[86px]" : "pl-4")}
        style={windowDragStyle}
      >
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            ref={backButtonRef}
            onClick={onBack}
            aria-label="Back"
            title="Back"
            className="flex size-9 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
            style={windowNoDragStyle}
          >
            <HIcon icon={ArrowLeft01Icon} size={18} />
          </button>
          <h1 data-tour="automations-page" className="mr-1 text-[18px] font-semibold tracking-tight text-ink">{t("routines.title")}</h1>
          {datedView && (
            <div className="flex min-w-0 items-center gap-1" style={windowNoDragStyle}>
              <button type="button" onClick={() => setAnchor((current) => addDays(current, -viewDays))} className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink" aria-label={t("routines.previous")}><HIcon icon={ChevronLeftIcon} size={16} /></button>
              <button type="button" onClick={() => setAnchor((current) => addDays(current, viewDays))} className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink" aria-label={t("routines.next")}><HIcon icon={ChevronRightIcon} size={16} /></button>
              <div className="min-w-0 truncate px-1 text-[14px] font-medium text-ink" aria-live="polite">{calendarRangeLabel(rangeStart, viewDays)}</div>
              <button type="button" onClick={goToday} className="ml-1 rounded-lg border border-hairline/50 bg-panel px-2.5 py-1 text-[12px] font-medium text-ink hover:bg-raised">{t("routines.today")}</button>
            </div>
          )}
          <div className="ml-auto flex flex-wrap items-center gap-2" style={windowNoDragStyle}>
            <div role="group" className="flex items-center rounded-lg border border-hairline/50 bg-panel p-0.5" aria-label={t("routines.view.label")}>
              <button type="button" aria-pressed={shownSection === "calendar" && layout === "day"} onClick={() => showLayout("day")} className={segment(shownSection === "calendar" && layout === "day")}>{t("routines.view.day")}</button>
              <button type="button" aria-pressed={shownSection === "calendar" && layout === "week"} onClick={() => showLayout("week")} className={segment(shownSection === "calendar" && layout === "week")}>{t("routines.view.week")}</button>
              <button type="button" aria-pressed={shownSection === "calendar" && layout === "list"} onClick={() => showLayout("list")} className={segment(shownSection === "calendar" && layout === "list")}>{t("routines.view.list")}</button>
            </div>
            <button type="button" aria-pressed={shownSection === "logs"} onClick={() => { if (shownSection === "logs") { setSection("calendar"); return; } setSection("logs"); setRoutineFilter(undefined); }} className={cn("flex items-center gap-1.5 rounded-lg border border-hairline/50 px-2.5 py-1.5 text-[12px] font-medium", shownSection === "logs" ? "bg-raised text-ink" : "bg-panel text-ink-secondary hover:text-ink")}><HIcon icon={FileTextIcon} size={13} />{t("routines.logs")}{unseenFailures > 0 && <span className="rounded-full bg-danger/10 px-1.5 text-[9px] text-danger">{unseenFailures}</span>}</button>
            {webhooksAvailable && <button type="button" aria-pressed={shownSection === "webhooks"} onClick={() => setSection(shownSection === "webhooks" ? "calendar" : "webhooks")} className={cn("flex items-center gap-1.5 rounded-lg border border-hairline/50 px-2.5 py-1.5 text-[12px] font-medium", shownSection === "webhooks" ? "bg-raised text-ink" : "bg-panel text-ink-secondary hover:text-ink")}><HIcon icon={WebhookIcon} size={13} />{t("routines.webhooks")}{state.webhooks.length > 0 && <span className="rounded-full bg-accent/15 px-1.5 text-[9px] text-accent-text">{state.webhooks.length}</span>}</button>}
            {shownSection === "webhooks"
              ? <button type="button" disabled={visibleBots.length === 0} onClick={() => setWebhookCreateRequest((request) => request + 1)} className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-[12px] font-semibold text-accent-ink hover:brightness-110 disabled:opacity-40"><HIcon icon={PlusSignIcon} size={15} aria-hidden="true" />{t("routines.newWebhook")}</button>
              : <button type="button" onClick={createRoutine} className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-[12px] font-semibold text-accent-ink hover:brightness-110"><HIcon icon={PlusSignIcon} size={15} aria-hidden="true" />{t("routines.newRoutine")}</button>}
          </div>
        </div>
        {shownSection !== "webhooks" && <div className="mt-2 flex flex-wrap items-center gap-2" style={windowNoDragStyle}>
          {unseenFailures > 0 && <button type="button" onClick={() => dispatch({ type: "markAllRoutineRunsSeen" })} className="flex items-center gap-1.5 rounded-lg border border-hairline/50 bg-panel px-2.5 py-1.5 text-[11.5px] text-ink-secondary hover:bg-raised hover:text-ink" title={t("routines.markAllSeen")} aria-label={t("routines.markAllSeen")}><HIcon icon={TickDouble01Icon} size={12} />{t("routines.markAllSeen")}</button>}
          {running > 0 && <span className="flex items-center gap-1.5 rounded-full bg-accent/10 px-2.5 py-1.5 text-[10.5px] text-accent-text"><HIcon icon={Loading02Icon} size={11} className="animate-spin" />{running} active</span>}
          {unseenFailures > 0 && <button type="button" onClick={() => dispatch({ type: "showRoutines", section: "logs", runStatus: "problems" })} className="flex items-center gap-1.5 rounded-full bg-danger/10 px-2.5 py-1.5 text-[10.5px] text-danger" title="Open problem run logs" aria-label="Open problem run logs"><HIcon icon={AlertCircleIcon} size={11} />{unseenFailures}</button>}
          {paused.length > 0 && <button type="button" onClick={() => setPausedOpen(true)} aria-label="View paused routines" className="flex items-center gap-1.5 rounded-full border border-hairline/50 px-2.5 py-1.5 text-[10.5px] text-ink-secondary hover:bg-raised"><HIcon icon={PauseIcon} size={11} />{paused.length}</button>}
          <div className="ml-auto flex items-center gap-2">
            <select aria-label="Filter schedule by bot" value={botFilter} onChange={(event) => { setBotFilter(event.target.value); setRoutineFilter(undefined); }} className="max-w-[180px] rounded-lg border border-hairline/50 bg-panel px-2.5 py-1.5 text-[11.5px] text-ink outline-none focus:border-accent"><option value="all">All bots</option>{visibleBots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select>
          </div>
          {error && <button type="button" onClick={() => setError("")} className="flex items-center gap-1.5 rounded-lg bg-danger/10 px-2.5 py-1.5 text-[10.5px] text-danger"><HIcon icon={AlertCircleIcon} size={11} />{error}<HIcon icon={MultiplicationSignIcon} size={11} /></button>}
          {datedView && state.routinesLoadState === "error" && <p role="alert" className="w-full text-[11.5px] text-danger">{t("routines.loadError")}</p>}
          {datedView && state.routinesLoadState === "loading" && state.routines.length === 0 && <p role="status" className="w-full text-[11.5px] text-ink-secondary">{t("routines.loading")}</p>}
        </div>}
      </header>
      <RoutineWakeBar />

      <div className="@container/routines relative flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {shownSection === "webhooks" ? <WebhooksPanel bots={visibleBots} createRequest={webhookCreateRequest} onCreateHandled={handleWebhookCreateHandled} /> : shownSection === "logs" ? (
            <div className="min-h-0 flex-1 overflow-y-auto"><RoutineLogs runs={filteredRuns} bots={state.bots} loading={state.routinesLoadState === "loading" && filteredRuns.length === 0} error={state.routinesLoadState === "error"} routineId={routineFilter} status={statusFilter} onStatusChange={setStatusFilter} onClearRoutine={() => setRoutineFilter(undefined)} onOpen={openRun} /></div>
          ) : layout === "list" ? (
            <div className="min-h-0 flex-1 overflow-y-auto"><div className="mx-auto w-full max-w-4xl space-y-5 p-4 sm:p-6">
              <div><h2 className="text-[17px] font-semibold text-ink">{t("routines.title")}</h2><p className="mt-1 text-[12px] text-ink-secondary">All schedules, including paused and finished routines.</p></div>
              <RoutineList routines={filteredRoutines} runs={state.routineRuns} bots={state.bots} loading={state.routinesLoadState === "loading" && filteredRoutines.length === 0} error={state.routinesLoadState === "error"} onOpen={openRoutine} onLogs={openLogs} />
              {!routinesOnly && calls.some((call) => botFilter === "all" || call.botIds.includes(botFilter)) && <section className="space-y-2" aria-label="Scheduled calls"><h2 className="text-[15px] font-semibold text-ink">Scheduled calls</h2>{calls.filter((call) => botFilter === "all" || call.botIds.includes(botFilter)).map((call) => <button key={call.id} type="button" onClick={() => setSelected({ kind: "call", id: call.id, at: call.schedule.type === "once" ? call.schedule.at : atLocalTime(Date.now(), call.schedule.time), durationMinutes: call.durationMinutes, call })} className="flex w-full items-center gap-3 rounded-xl border border-hairline/40 bg-card p-4 text-left hover:bg-raised"><HIcon icon={Video01Icon} size={17} className="text-accent" /><span><span className="block text-[13px] font-medium text-ink">{call.name}</span><span className="mt-1 block text-[11.5px] text-ink-secondary">{scheduleLabel(call.schedule)}</span></span></button>)}</section>}
            </div></div>
          ) : (
            <div className="flex min-h-0 flex-1">
              {!drawerOpen && <div className="hidden shrink-0 @min-[1040px]/routines:block"><CalendarSidebar bots={visibleBots} anchor={anchor} onSelectDate={(at) => setAnchor(startOfDay(at))} /></div>}
              <CalendarGrid anchor={rangeStart} days={viewDays} items={items} bots={state.bots} selectedId={liveSelected?.id} onOpen={openItem} onCreate={openCreate} onMove={(item, at) => void moveEvent(item, at)} onResize={(item, duration) => void resizeEvent(item, duration)} />
            </div>
          )}
        </div>
        {/* Beside the grid when there is room; over it on a narrow window. */}
        {drawerOpen && liveSelected && (
          <div className="absolute inset-y-0 right-0 z-30 flex shadow-2xl @min-[760px]/routines:static @min-[760px]/routines:shadow-none">
            <EventDetails key={`${liveSelected.kind}:${liveSelected.id}`} item={liveSelected} bots={state.bots} onClose={() => setSelected(null)} onEdit={editSelected} onOpenRun={openRun} onCallChanged={(id) => { if (id) setCalls((current) => current.filter((call) => call.id !== id)); else void loadCalls(); }} onOpenChat={onOpenChat} />
          </div>
        )}
      </div>

      {quick && <><div className="fixed inset-0 z-40 bg-black/25" onMouseDown={() => setQuick(null)} /><QuickComposer seed={quick} bots={visibleBots} routinesOnly={routinesOnly} onClose={() => setQuick(null)} onMore={(seed) => { setQuick(null); setEditor(seed); }} onSavedRoutine={(routine) => dispatch({ type: "routinePatched", routine })} onSavedCall={upsertCall} /></>}
      {editor && <EventEditor seed={editor} bots={visibleBots} routinesOnly={routinesOnly} onClose={() => setEditor(null)} onSavedCall={upsertCall} />}
      {pausedOpen && <PausedList routines={paused} bots={state.bots} onClose={() => setPausedOpen(false)} onEdit={(routine) => { setPausedOpen(false); setEditor({ kind: "routine", at: routineAt(routine), durationMinutes: routine.durationMinutes, botIds: [routine.botId], routine }); }} />}
    </main>
  );
}

/** Desktop only: the one lever the app has against a sleeping computer.
 * The scheduler runs inside the local server, so while the Mac sleeps no
 * routine fires; the shell holds a power assertion for the hour before a
 * due routine and while one runs, plugged in only, and this row shows it. */
function RoutineWakeBar() {
  const bridge = typeof window !== "undefined" ? window.colonie?.routines : undefined;
  const [state, setState] = useState<DesktopRoutineWake | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    const load = () => bridge.wakeState().then((next) => { if (!cancelled) setState(next); }).catch(() => {});
    void load();
    const timer = window.setInterval(load, 30_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [bridge]);
  if (!bridge || !state) return null;
  const status = !state.keepAwake
    ? "Off — this computer may sleep through a scheduled routine."
    : state.onBattery
      ? "On battery, so not holding; plug in to keep it awake."
      : state.hold
        ? state.reason === "running" ? "Holding it awake now: a routine is running." : `Holding it awake now: a routine is due at ${state.at ? niceTime(state.at) : "the top of the hour"}.`
        : "Holds it awake for the hour before a routine and while one runs, while plugged in. A closed lid still sleeps.";
  return (
    <div className="flex items-center justify-between gap-4 border-b border-hairline/35 bg-panel/60 px-4 py-2.5">
      <div className="min-w-0 text-[12px] leading-relaxed text-ink-secondary">
        <span className="font-medium text-ink">Keep this computer awake for routines.</span> {status}
      </div>
      <Switch
        checked={state.keepAwake}
        disabled={busy}
        aria-label="Keep this computer awake for scheduled routines"
        onClick={() => {
          setBusy(true);
          bridge.keepAwake(!state.keepAwake).then(setState).catch(() => {}).finally(() => setBusy(false));
        }}
        className="shrink-0 disabled:cursor-wait disabled:opacity-50"
      />
    </div>
  );
}
