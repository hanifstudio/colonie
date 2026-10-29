import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { configureDefaultFonts, DocxEditor, type DocxEditorRef } from "@betteroffice/docx-react";
import * as fonts from "@betteroffice/fonts";
import "@betteroffice/docx-react/styles.css";
import { PreviewToolbar } from "./PreviewToolbar";

// Bundled assets only: opening a report never sends it to an Office service.
configureDefaultFonts({ fonts });
const MEMORY_BUDGET = { workerLimitBytes: 256 * 1024 * 1024 };
const VIEWER_STYLE = { height: "100%", border: "none", borderRadius: 0, "--doc-bg": "var(--color-inset)" } as CSSProperties;

export default function DocxPreview({ bytes, name, onError }: {
  bytes: Uint8Array<ArrayBuffer>; name: string; onError: () => void;
}) {
  const editor = useRef<DocxEditorRef>(null);
  const host = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState<number | null>(null);
  const [fit, setFit] = useState(0.6);
  const [ready, setReady] = useState(false);
  const [pages, setPages] = useState<number | null>(null);
  useEffect(() => {
    if (ready) return;
    const timer = setTimeout(onError, 60_000);
    return () => clearTimeout(timer);
  }, [ready, onError]);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const read = () => setFit(Math.max(0.1, Math.min(1, (element.clientWidth - 48) / 816)));
    read();
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { if (ready) editor.current?.setZoom(zoom ?? fit); }, [zoom, fit, ready]);
  useEffect(() => {
    let alive = true;
    if (!ready) return;
    void editor.current?.whenLayoutComplete({ timeoutMs: 60_000 }).then((count) => {
      if (!alive) return;
      if (count > 1000) onError();
      else setPages(count);
    }).catch(() => { if (alive) onError(); });
    return () => { alive = false; };
  }, [ready, onError]);
  const painted = useCallback(() => setReady(true), []);
  const fail = useCallback((_error: Error, info?: { recoverable?: boolean }) => {
    if (!info?.recoverable) onError();
  }, [onError]);
  return <>
    <PreviewToolbar zoom={zoom} fitZoom={fit} onZoom={setZoom}>{pages === null ? "Word document" : `${pages} ${pages === 1 ? "page" : "pages"}`}</PreviewToolbar>
    <div ref={host} className="file-preview-docx min-h-0 flex-1 overflow-hidden">
      <DocxEditor ref={editor} documentBuffer={bytes} documentName={name} readOnly mode="viewing"
        showToolbar={false} showZoomControl={false} showRuler={false} showOutlineButton={false}
        showFileOpen={false} showHelpMenu={false} downloadOnSave={false} disableFindReplaceShortcuts
        colorMode="light" initialZoom={fit} memoryBudget={MEMORY_BUDGET}
        onFirstPagePainted={painted} onError={fail} style={VIEWER_STYLE} />
    </div>
  </>;
}
