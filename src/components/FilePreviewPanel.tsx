// A Markdown file a bot shared, opened for reading in the right-side slot
// Activity and the Inspector use. The bytes come through the same
// message-scoped grant as the chat's save button, so the panel can only
// ever show what that message already shares — never an arbitrary path.
// The document renders with the chat's Markdown, but without a message
// scope, so links inside it stay inert instead of gaining file access.
import { useEffect, useState } from "react";
import { FileTextIcon, Loading02Icon, MultiplicationSignIcon, RefreshCwIcon } from "@hugeicons/core-free-icons";
import { HIcon } from "./HIcon";
import { useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { useCaptionChrome } from "@/components/DesktopCapabilities";
import { t } from "@/lib/i18n";
import { ChatMarkdown } from "./ChatMarkdown";
import {
  readMarkdownResponse,
  requestMessageFile,
  type FilePreviewTarget,
} from "./AttachmentPreview";

export function FilePreviewPanel({ preview }: { preview: FilePreviewTarget }) {
  const { dispatch } = useStore();
  const { padClass } = useCaptionChrome();
  const [attempt, setAttempt] = useState(0);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<"load" | "size" | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setContent(null);
    setError(null);
    void (async () => {
      try {
        const response = await requestMessageFile(
          preview.path,
          { threadId: preview.threadId, messageId: preview.messageId },
          controller.signal,
        );
        const text = await readMarkdownResponse(response, controller.signal);
        if (!controller.signal.aborted) setContent(text);
      } catch (reason) {
        if (controller.signal.aborted) return;
        setError(reason instanceof Error && reason.message === "size" ? "size" : "load");
      }
    })();
    return () => controller.abort();
  }, [preview.threadId, preview.messageId, preview.path, attempt]);

  return (
    <aside aria-label={t("attach.previewFile", { name: preview.name })} className="animate-panel-in flex h-full w-[400px] max-w-full shrink-0 flex-col border-l border-hairline/40 bg-panel max-md:absolute max-md:inset-y-0 max-md:right-0 max-md:z-30">
      <div className={cn("flex items-center justify-between gap-2 px-4 py-3", padClass)}>
        <span className="flex min-w-0 items-center gap-2 text-[15px] font-semibold text-ink">
          <HIcon icon={FileTextIcon} size={16} className="shrink-0 text-ink-secondary" />
          <span className="min-w-0 truncate" title={preview.name}>{preview.name}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <button
            onClick={() => setAttempt((value) => value + 1)}
            className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
            title={t("chat.retry")}
            aria-label={t("chat.retry")}
          >
            <HIcon icon={RefreshCwIcon} size={14} />
          </button>
          <button
            onClick={() => dispatch({ type: "closeFilePreview" })}
            aria-label={t("attach.previewClose")}
            title={t("attach.previewClose")}
            className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <HIcon icon={MultiplicationSignIcon} size={18} />
          </button>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
        {error ? (
          <p role="alert" className="mt-2 rounded-xl bg-card p-4 text-[13px] leading-6 text-ink-secondary">
            {t(error === "size" ? "attach.previewTooLarge" : "attach.previewLoadFailed")}
          </p>
        ) : content === null ? (
          <p role="status" className="mt-2 flex items-center gap-2 rounded-xl bg-card p-4 text-[13px] text-ink-secondary">
            <HIcon icon={Loading02Icon} size={14} className="animate-spin" />{t("attach.previewLoading")}
          </p>
        ) : (
          <ChatMarkdown text={content} />
        )}
      </div>
    </aside>
  );
}
