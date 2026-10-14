// Authorized live delivery for workspace streams. The hub is transport
// agnostic: a route owns the socket and hands in a `deliver` callback. Access
// is re-checked on every frame, not only at subscribe time, so removing a
// member stops their stream immediately rather than at the next reconnect.
//
// A `revoked` frame is addressed to one account: it is delivered to that
// account's subscriber and then that subscriber is closed.
import type { PlatformStreamFrame } from "../../../shared/colonie-platform.ts";

/** Re-check access to a workspace (and optional conversation) for an account. */
export type AuthorizeFrame = (input: { workspaceId: string; conversationId?: string; accountId: string }) => Promise<boolean>;

export interface StreamDelivery {
  /** Serialize one frame to the client. Must not throw. */
  deliver(frame: PlatformStreamFrame): void | Promise<void>;
  /** The stream is over (revoked, unauthorized, or client gone). */
  close(reason?: string): void;
}

interface Subscriber extends StreamDelivery {
  id: string;
  workspaceId: string;
  accountId: string;
  conversationId?: string;
  closed: boolean;
}

export class StreamHub {
  private readonly subscribers = new Set<Subscriber>();
  private readonly authorize: AuthorizeFrame;

  constructor(authorize: AuthorizeFrame) {
    this.authorize = authorize;
  }

  subscribe(input: { workspaceId: string; accountId: string; id: string; conversationId?: string; delivery: StreamDelivery }): () => void {
    const subscriber: Subscriber = { ...input.delivery, id: input.id, workspaceId: input.workspaceId, accountId: input.accountId, conversationId: input.conversationId, closed: false };
    this.subscribers.add(subscriber);
    return () => this.drop(subscriber);
  }

  /** Live subscriber count, for tests and metrics. */
  size(workspaceId?: string): number {
    if (!workspaceId) return this.subscribers.size;
    return [...this.subscribers].filter((s) => s.workspaceId === workspaceId).length;
  }

  private drop(subscriber: Subscriber): void {
    if (subscriber.closed) return;
    subscriber.closed = true;
    this.subscribers.delete(subscriber);
    try {
      subscriber.close("dropped");
    } catch {
      // closing a dead socket is not an error worth surfacing
    }
  }

  /**
   * Deliver a frame to every eligible subscriber in the frame's workspace.
   * `audienceAccountId` targets a single account (a `revoked` notice) and
   * closes it after delivery. A subscriber filtered to one conversation never
   * receives another conversation's frame.
   */
  async emit(frame: PlatformStreamFrame, options: { workspaceId: string; conversationId?: string; audienceAccountId?: string }): Promise<void> {
    const targets = [...this.subscribers].filter((s) => s.workspaceId === options.workspaceId);
    await Promise.allSettled(
      targets.map(async (subscriber) => {
        if (subscriber.closed) return;
        if (options.audienceAccountId !== undefined) {
          if (subscriber.accountId !== options.audienceAccountId) return;
          try {
            await subscriber.deliver(frame);
          } finally {
            this.drop(subscriber);
          }
          return;
        }
        if (subscriber.conversationId && options.conversationId && options.conversationId !== subscriber.conversationId) return;
        const allowed = await this.authorize({ workspaceId: subscriber.workspaceId, conversationId: options.conversationId, accountId: subscriber.accountId }).catch(() => false);
        if (!allowed) {
          // A private (conversation) frame this subscriber cannot see is simply
          // skipped: they are still a workspace member. Only a denied
          // workspace-level frame means membership was revoked — then the whole
          // stream is dropped.
          if (!options.conversationId) this.drop(subscriber);
          return;
        }
        try {
          await subscriber.deliver(frame);
        } catch {
          this.drop(subscriber);
        }
      }),
    );
  }

  /** Close every stream for a workspace, e.g. a workspace-wide re-sync. */
  closeWorkspace(workspaceId: string): void {
    for (const subscriber of this.subscribers) {
      if (subscriber.workspaceId === workspaceId) this.drop(subscriber);
    }
  }

  /** Close every live stream, e.g. on shutdown, before the database closes. */
  closeAll(): void {
    for (const subscriber of this.subscribers) this.drop(subscriber);
  }
}
