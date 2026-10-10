/** App-authored ACP context is user content, not a replacement system prompt. */
export interface AppContextPreferences { enabled: boolean; instructions: string }
export interface BotContextPreferences { persona: boolean; soul: boolean }
export interface AcpContextSection {
  id: string;
  label: string;
  scope: "app" | "bot" | "instance" | "conversation";
  source: string;
  version: string;
  hash: string;
  status: "active" | "disabled" | "empty";
  text: string;
}
export interface AcpContextSnapshot {
  version: 1;
  botId: string;
  hash: string;
  sections: AcpContextSection[];
  app: AppContextPreferences;
  bot: BotContextPreferences;
  legacyPlain: boolean;
}
export interface AcpContextManifest {
  version: 1;
  snapshotHash?: string;
  pinnedAt?: string;
  botId?: string;
  sections: Array<AcpContextSection & { blockIndex?: number }>;
}
export interface AcpContextView {
  app: AppContextPreferences & { revision: string };
  bot: BotContextPreferences & { revision: string };
  pinned: (AcpContextSnapshot & { pinnedAt: string }) | null;
  preview: AcpContextSnapshot;
  changed: boolean;
}
