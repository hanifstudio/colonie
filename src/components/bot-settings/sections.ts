// The bot settings dialog's section rail — one entry per BotSettingsSection,
// in the fixed order the rail renders them. Search filters against label
// plus keywords, the same convention as the app SettingsModal's SECTIONS.
// "slack" is listed here but shown only when the server offers a link to the
// organisation's Admin (BotSettingsDialog filters it out otherwise), and
// "visibility" only to an admin in a browser (never in the desktop app).
import {
  BookOpen01Icon,
  BrainIcon,
  CalendarClockIcon,
  Coins01Icon,
  CpuIcon,
  DashboardSquare01Icon,
  HistoryIcon,
  Mic01Icon,
  NetworkIcon,
  ShieldCheckIcon,
  SlackIcon,
  SparklesIcon,
  UserIcon,
  ViewIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";

import type { BotSettingsSection } from "@/state/store";
import type { LocaleKey } from "@/locales";

/** `labelKey`, when present, is the translated label (read at render time);
 * `label` stays the English fallback and search text. */
export const BOT_SECTIONS: Array<{
  id: BotSettingsSection;
  label: string;
  labelKey?: LocaleKey;
  icon: IconSvgElement;
  keywords: string[];
}> = [
  { id: "overview", label: "Overview", icon: DashboardSquare01Icon, keywords: ["summary", "status", "what it does", "won't", "prompt", "what the model sees"] },
  { id: "identity", label: "Identity", icon: UserIcon, keywords: ["name", "title", "avatar", "blurb", "instructions"] },
  { id: "slack", label: "Slack", icon: SlackIcon, keywords: ["slack", "slack app", "admin", "message", "direct messages", "mentions"] },
  { id: "soul", label: "Soul", icon: SparklesIcon, keywords: ["standing instructions", "instructions", "persona", "rules", "soul.md"] },
  { id: "skills", label: "Skills", icon: BookOpen01Icon, keywords: ["skills", "learned", "procedures", "teach"] },
  { id: "memory", label: "Memory", icon: BrainIcon, keywords: ["memory", "notes", "remember", "topics"] },
  { id: "routines", label: "Routines", icon: CalendarClockIcon, keywords: ["schedule", "routines", "cron", "tasks"] },
  { id: "access", label: "Access", icon: NetworkIcon, keywords: ["works on", "computer", "vm", "folder", "workspace", "browser", "connected apps", "composio", "webhooks", "always allow", "grants", "tool selection", "tools", "mcp", "allow", "exclude"] },
  { id: "model", label: "Model", icon: CpuIcon, keywords: ["engine", "model", "provider", "cli", "effort"] },
  { id: "permissions", label: "Permissions", icon: ShieldCheckIcon, keywords: ["auto mode", "approve", "auto approve", "review", "routine approvals", "peers", "contact", "coordination", "chief of staff", "section"] },
  { id: "voice", label: "Voice & alerts", icon: Mic01Icon, keywords: ["voice", "alerts", "notifications", "speak"] },
  { id: "visibility", label: "Who can see it", labelKey: "botSettings.visibility.title", icon: ViewIcon, keywords: ["visibility", "who can see", "private", "people", "admins", "members", "access", "hide"] },
  { id: "history", label: "History", icon: HistoryIcon, keywords: ["history", "changes", "undo", "rollback", "log"] },
  { id: "usage", label: "Usage", icon: Coins01Icon, keywords: ["tokens", "cost", "billing"] },
];
