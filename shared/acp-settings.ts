export interface NativeOption {
  id: string;
  name: string;
  description?: string;
  category?: string;
  type: "select" | "boolean";
  currentValue: string | boolean;
  options: Array<{ value: string; name: string }>;
}

export interface NativeSettings {
  sessionId: string;
  instanceId: string;
  threadId: string;
  cwd: string;
  revision: string;
  modes: { currentModeId: string; availableModes: Array<{ id: string; name: string; description?: string }> };
  options: NativeOption[];
  warnings: string[];
}

export type NativeSettingChange = {
  sessionId: string;
  expectedRevision: string;
} & ({ kind: "mode"; value: string } | { kind: "option"; configId: string; value: string | boolean });
