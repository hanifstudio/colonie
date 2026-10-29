import { useEffect, useRef, useState } from "react";
import { getDocument, GlobalWorkerOptions, TextLayer, type PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { PreviewToolbar } from "./PreviewToolbar";
import { Loading02Icon } from "@hugeicons/core-free-icons";
import { HIcon } from "../HIcon";
import "./pdf-text-layer.css";

GlobalWorkerOptions.workerSrc = workerUrl;

export default function PdfPreview({ bytes, onError }: { bytes: Uint8Array<ArrayBuffer>; onError: () => void }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [zoom, setZoom] = useState<number | null>(null);
  const [width, setWidth] = useState(460);
  const [pageWidth, setPageWidth] = useState(612);
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    // pdf.js transfers its input to the worker; retain the original for refresh.
    const task = getDocument({ data: bytes.slice(), stopAtErrors: true, useSystemFonts: true });
    void task.promise.then(async (document) => {
      if (!alive) return;
      if (document.numPages > 1000) { onError(); return; }
      const firstPage = await document.getPage(1);
      if (!alive) return;
      setPageWidth(firstPage.getViewport({ scale: 1 }).width);
      setPdf(document);
    }).catch((cause: unknown) => { if (alive) { console.warn("[file-preview] PDF could not be opened", cause); onError(); } });
    return () => { alive = false; void task.destroy().catch(() => {}); };
  }, [bytes, onError]);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(Math.max(100, element.clientWidth - 40)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return <>
    <PreviewToolbar zoom={zoom} fitZoom={Math.min(1, width / pageWidth)} onZoom={setZoom}>{pdf ? `${pdf.numPages} ${pdf.numPages === 1 ? "page" : "pages"}` : "PDF document"}</PreviewToolbar>
    <div ref={host} className="file-preview-pdf min-h-0 flex-1 overflow-auto bg-inset/60 p-5">
      {!pdf && <div role="status" className="flex justify-center p-8 text-ink-secondary"><HIcon icon={Loading02Icon} size={18} className="animate-spin" /><span className="sr-only">Opening PDF…</span></div>}
      {pdf && Array.from({ length: pdf.numPages }, (_, index) => <PdfPage key={index} pdf={pdf} index={index} width={width} zoom={zoom} onError={onError} />)}
    </div>
  </>;
}

/** Only pages near the viewport hold canvases and selectable text. */
function PdfPage({ pdf, index, width, zoom, onError }: { pdf: PDFDocumentProxy; index: number; width: number; zoom: number | null; onError: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [geometry, setGeometry] = useState({ width: 612, height: 792 });
  const actualWidth = zoom === null ? Math.min(width, geometry.width) : geometry.width * zoom;
  useEffect(() => {
    if (!host.current) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry?.isIntersecting ?? false), { root: host.current.parentElement, rootMargin: "400px" });
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || !canvas.current || !text.current) return;
    let alive = true;
    let render: ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]> | undefined;
    let layer: TextLayer | undefined;
    const element = canvas.current, textElement = text.current;
    void (async () => {
      const page = await pdf.getPage(index + 1);
      if (!alive) return;
      const natural = page.getViewport({ scale: 1 });
      setGeometry((old) => old.width === natural.width && old.height === natural.height ? old : { width: natural.width, height: natural.height });
      const scale = zoom ?? Math.min(1, width / natural.width);
      const viewport = page.getViewport({ scale });
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      element.width = Math.ceil(viewport.width * ratio);
      element.height = Math.ceil(viewport.height * ratio);
      render = page.render({ canvas: element, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
      await render.promise;
      if (!alive) return;
      textElement.style.setProperty("--total-scale-factor", String(scale));
      layer = new TextLayer({ textContentSource: await page.getTextContent(), container: textElement, viewport });
      if (!alive) return;
      await layer.render();
    })().catch((cause: unknown) => { if (alive) { console.warn("[file-preview] PDF page could not be displayed", cause); onError(); } });
    return () => {
      alive = false; render?.cancel(); layer?.cancel(); textElement.replaceChildren();
      // A new render waits for this effect's cleanup before reusing the canvas.
    };
  }, [visible, pdf, index, width, zoom, onError]);
  return <div ref={host} role="group" aria-label={`Page ${index + 1}`} className="relative mx-auto mb-5 bg-white shadow-sm last:mb-0" style={{ width: actualWidth, height: actualWidth * geometry.height / geometry.width }}>
    {visible && <><canvas ref={canvas} className="size-full" /><div ref={text} className="textLayer" /></>}
    <span className="absolute bottom-1 right-2 select-none rounded bg-white/80 px-1 text-[10px] text-neutral-500" aria-hidden="true">{index + 1}</span>
  </div>;
}
