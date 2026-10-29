// Every byte uses the same exact-message grant as Save; previewing never
// grants arbitrary file access or sends a document to an Office service.
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Download01Icon, FileTextIcon, Loading02Icon, MultiplicationSignIcon, RefreshCwIcon } from "@hugeicons/core-free-icons";
import { HIcon } from "./HIcon";
import { useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { useCaptionChrome } from "@/components/DesktopCapabilities";
import { t } from "@/lib/i18n";
import { ChatMarkdown, CodeBlock } from "./ChatMarkdown";
import { decodePreviewText, DOCUMENT_PREVIEW_MAX_BYTES, filePreviewKind, previewImageMime, readPreviewBytes, TEXT_PREVIEW_MAX_BYTES, type FilePreviewKind } from "@/lib/file-preview";
import { messageImagePreviewUrl, OutsideWorkspaceFile, requestMessageFile, useLocalFileSave, type FilePreviewTarget } from "./AttachmentPreview";
import { PREVIEW_ACTION, PreviewToolbar } from "./file-preview/PreviewToolbar";
import { usePreviewPanel } from "./file-preview/use-preview-panel";
import { PreviewBoundary } from "./file-preview/PreviewBoundary";

const DocxPreview = lazy(() => import("./file-preview/DocxPreview"));
const PdfPreview = lazy(() => import("./file-preview/PdfPreview"));
type LoadedFile = { kind: FilePreviewKind; bytes: Uint8Array<ArrayBuffer>; text?: string; image?: string };
type PreviewError = "load" | "size" | "format" | "unsupported" | "outside_workspace";

export function FilePreviewPanel({ preview }: { preview: FilePreviewTarget }) {
  const { dispatch } = useStore();
  const { padClass } = useCaptionChrome();
  const { panel, width, minimum, maximum, resize } = usePreviewPanel();
  const heading = useRef<HTMLHeadingElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [content, setContent] = useState<LoadedFile | null>(null);
  const [error, setError] = useState<PreviewError | null>(null);
  const save = useLocalFileSave(preview.path, preview.name, preview);
  const close = useCallback(() => dispatch({ type: "closeFilePreview" }), [dispatch]);
  const failRender = useCallback(() => { setContent(null); setError("format"); }, []);

  useLayoutEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = panel.current;
    heading.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || document.querySelector('[role="dialog"]')) return;
      event.preventDefault(); close();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (opener?.isConnected && element?.contains(document.activeElement)) opener.focus({ preventScroll: true });
    };
  }, [close, panel]);

  useEffect(() => {
    const controller = new AbortController();
    let image: string | undefined;
    setContent(null); setError(null);
    const kind = filePreviewKind(preview.path);
    if (!kind) { setError("unsupported"); return; }
    const timer = setTimeout(() => { setError("load"); controller.abort(); }, 30_000);
    void (async () => {
      try {
        const response = preview.sourceOffset === undefined
          ? await requestMessageFile(preview.path, preview, controller.signal)
          : await fetch(messageImagePreviewUrl(preview, preview.sourceOffset), { signal: controller.signal });
        const bytes = await readPreviewBytes(response, controller.signal, kind === "markdown" || kind === "text" ? TEXT_PREVIEW_MAX_BYTES : DOCUMENT_PREVIEW_MAX_BYTES);
        controller.signal.throwIfAborted();
        const text = kind === "markdown" || kind === "text" ? decodePreviewText(bytes) : undefined;
        if (kind === "pdf" && new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") throw new Error("format");
        if (kind === "docx" && (bytes[0] !== 80 || bytes[1] !== 75)) throw new Error("format");
        if (kind === "image") image = URL.createObjectURL(new Blob([bytes], { type: previewImageMime(preview.path) }));
        setContent({ kind, bytes, text, image });
      } catch (reason) {
        if (controller.signal.aborted) return;
        const code = (reason as { code?: string })?.code;
        setError(code === "outside_workspace" ? code : reason instanceof Error && (reason.message === "size" || reason.message === "format") ? reason.message : "load");
      } finally { clearTimeout(timer); }
    })();
    return () => { clearTimeout(timer); controller.abort(); if (image) URL.revokeObjectURL(image); };
  }, [preview.threadId, preview.messageId, preview.path, preview.sourceOffset, attempt]);

  return <aside ref={panel} aria-label={t("attach.previewFile", { name: preview.name })} className="animate-panel-in relative flex h-full max-w-full shrink-0 flex-col border-l border-hairline/40 bg-panel max-md:absolute max-md:inset-0 max-md:z-40 max-md:w-full!" style={{ width }}>
    <div role="separator" aria-label="Resize file preview" aria-orientation="vertical" aria-valuemin={minimum} aria-valuemax={maximum} aria-valuenow={width} tabIndex={0} {...resize} className="absolute inset-y-0 left-0 z-10 w-1.5 touch-none cursor-col-resize transition-colors hover:bg-accent/30 focus-visible:bg-accent/50 focus-visible:outline-none max-md:hidden" />
    <header className={cn("flex min-h-16 shrink-0 items-center gap-3 border-b border-hairline/30 px-4 py-3", padClass)}>
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-raised/70 text-ink-secondary"><HIcon icon={FileTextIcon} size={18} /></span>
      <div className="min-w-0 flex-1">
        <h2 ref={heading} tabIndex={-1} className="truncate text-[13px] font-semibold text-ink outline-none" title={preview.name}>{preview.name}</h2>
        <p className="mt-0.5 text-[11px] text-ink-tertiary">{t("attach.previewTitle")} · Read only</p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <button type="button" onClick={() => void save.save()} disabled={save.state === "saving"} className={PREVIEW_ACTION} title={t("attach.saveAria", { name: preview.name })} aria-label={t("attach.saveAria", { name: preview.name })}><HIcon icon={save.state === "saving" ? Loading02Icon : Download01Icon} size={16} className={save.state === "saving" ? "animate-spin" : undefined} /></button>
        <button type="button" onClick={() => setAttempt((value) => value + 1)} className={PREVIEW_ACTION} title="Refresh preview" aria-label="Refresh preview"><HIcon icon={RefreshCwIcon} size={15} /></button>
        <button type="button" onClick={close} className={PREVIEW_ACTION} title={t("attach.previewClose")} aria-label={t("attach.previewClose")}><HIcon icon={MultiplicationSignIcon} size={18} /></button>
      </div>
    </header>
    {save.state === "failed" && <p role="alert" className="border-b border-hairline/30 px-4 py-2 text-[12px] text-danger">{save.reason}</p>}
    {save.state === "saved" && <p role="status" className="border-b border-hairline/30 px-4 py-2 text-[12px] text-success">{t("attach.downloaded")}</p>}
    {error ? <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
      <span className="mb-1 flex size-12 items-center justify-center rounded-2xl bg-raised text-ink-secondary"><HIcon icon={FileTextIcon} size={22} /></span>
      <p role="alert" className="max-w-72 text-[13px] leading-6 text-ink-secondary">{error === "size" ? t("attach.previewTooLarge") : error === "unsupported" ? "Preview is not available for this file type. Save a copy to open it in another app." : error === "format" ? "This file could not be displayed. It may be damaged or use an unsupported format. You can still save a copy." : error === "outside_workspace" ? "This file is outside this conversation’s workspace." : t("attach.previewLoadFailed")}</p>
      {error === "outside_workspace" ? <OutsideWorkspaceFile filePath={preview.path} /> : <button type="button" onClick={() => setAttempt((value) => value + 1)} className="rounded-lg border border-hairline/50 px-3 py-1.5 text-[12px] text-ink hover:bg-raised">{t("chat.retry")}</button>}
    </div> : content === null ? <PreviewLoading /> : <PreviewBoundary key={attempt} onError={failRender}><Suspense fallback={<PreviewLoading />}>
      {content.kind === "docx" ? <DocxPreview key={attempt} bytes={content.bytes} name={preview.name} onError={failRender} />
        : content.kind === "pdf" ? <PdfPreview key={attempt} bytes={content.bytes} onError={failRender} />
        : content.kind === "image" ? <ImagePreview src={content.image!} name={preview.name} onError={failRender} />
        : <div className="min-h-0 flex-1 overflow-auto px-5 py-5">
          {content.text!.length > 100_000 ? <>
            <p className="mb-4 text-[11px] text-ink-secondary">Showing plain text for this large file.</p>
            <pre className="select-text whitespace-pre-wrap break-words font-mono text-[12px] leading-6 text-ink">{content.text}</pre>
          </> : content.kind === "markdown" ? <ChatMarkdown text={content.text!} /> : <CodeBlock code={content.text!} lang={preview.name.split(".").at(-1) ?? "text"} />}
        </div>}
    </Suspense></PreviewBoundary>}
  </aside>;
}

function PreviewLoading() {
  return <div role="status" className="flex min-h-0 flex-1 items-center justify-center gap-2 text-[13px] text-ink-secondary"><HIcon icon={Loading02Icon} size={16} className="animate-spin" />{t("attach.previewLoading")}</div>;
}

function ImagePreview({ src, name, onError }: { src: string; name: string; onError: () => void }) {
  const [zoom, setZoom] = useState<number | null>(null);
  const [naturalWidth, setNaturalWidth] = useState(1);
  const [fit, setFit] = useState(1);
  const host = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const read = () => {
      const img = image.current;
      if (img?.naturalWidth) setFit(Math.min(1, (element.clientWidth - 40) / img.naturalWidth, (element.clientHeight - 40) / img.naturalHeight));
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, [naturalWidth]);
  return <>
    <PreviewToolbar zoom={zoom} fitZoom={fit} onZoom={setZoom}>Image</PreviewToolbar>
    <div ref={host} className="min-h-0 flex-1 overflow-auto bg-inset/60 p-5">
      <img ref={image} src={src} alt={name} onError={onError} onLoad={(event) => setNaturalWidth(event.currentTarget.naturalWidth)} draggable={false} className={zoom === null ? "mx-auto max-h-full max-w-full object-contain" : "mx-auto max-w-none"} style={zoom === null ? undefined : { width: naturalWidth * zoom }} />
    </div>
  </>;
}
