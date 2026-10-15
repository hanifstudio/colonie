/** One /api/search hit, resolved to the bot or room that owns it. */
export interface SearchHit {
  botId?: string;
  groupId?: string;
  name: string;
  threadId: string;
  task?: string;
  messageId: string;
  /** The message's position in its conversation; Cloud hits carry it so the
   * view can be loaded around the hit. Local hits leave it undefined. */
  sequence?: number;
  role: string;
  kind: string;
  from?: string;
  at: number;
  snippet: string;
  matchStart: number;
  matchLength: number;
  onActivePath: boolean;
}
