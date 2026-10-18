// What the computer feature and the `/api/desktop-viewer` route adapter agree on:
// the shape of a viewer target and how a viewer URL is addressed. It lives beside the
// feature because the feature produces targets and the route adapter consumes them —
// `server/routes/desktop-viewer.ts` imports this file, not the other way round.

/** Providers resolve a managed loopback endpoint, never a browser-supplied URL. */
export interface DesktopConnection {
  port: number;
  password: string | null;
  live?: () => boolean;
  touch?: () => void;
  /** Acquired only by WebSockets; release must not close other viewers. */
  retain?: () => () => void;
}
export interface DesktopTarget {
  key: string;
  resolve: () => Promise<DesktopConnection>;
}

export function desktopViewerUrl(target: string, threadId?: string): string {
  const params = new URLSearchParams({ target, ...(threadId ? { threadId } : {}) });
  return `/desktop-viewer#${params}`;
}
