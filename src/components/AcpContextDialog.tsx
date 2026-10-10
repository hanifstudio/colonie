import { useEffect, useRef, useState } from "react";
import { X, RefreshCw } from "lucide-react";
import { api, useStore } from "@/state/store";
import type { AcpInputReceipt } from "../../shared/devone";
import { useModalDialog } from "@/hooks/use-modal-dialog";
import type { AcpContextView } from "../../shared/acp-context";
import { AcpContextControls, ContextSections } from "./AcpContextControls";

export function AcpContextDialog({ botId, threadId, onClose }: { botId: string; threadId: string; onClose: () => void }) {
  const dialog = useRef<HTMLElement>(null);
  useModalDialog(dialog, onClose);
  const [receipts, setReceipts] = useState<AcpInputReceipt[] | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [view, setView] = useState<AcpContextView | null>(null);
  const { flushBotPatches } = useStore();
  useEffect(() => {
    const controller = new AbortController();
    setView(null); setReceipts(null);
    void flushBotPatches(botId).then(() => Promise.all([
      api(`/api/bots/${botId}/acp-inputs?threadId=${encodeURIComponent(threadId)}`, { signal: controller.signal }),
      api(`/api/bots/${botId}/acp-context?threadId=${encodeURIComponent(threadId)}`, { signal: controller.signal }),
    ]))
      .then(([result, context]: [{ receipts: AcpInputReceipt[] }, AcpContextView]) => { if (controller.signal.aborted) return; setReceipts(result.receipts); setView(context); setError(""); })
      .catch((cause: Error) => { if (!controller.signal.aborted) setError(cause.message); });
    return () => controller.abort();
  }, [botId, threadId, revision, flushBotPatches]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onClick={onClose}>
      <section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="ACP context" className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-2xl border border-hairline bg-panel p-5 shadow-xl" onClick={(event) => event.stopPropagation()}>
        <header className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-ink">ACP context · exact application input</h2>
          <div className="flex gap-2">
            <button aria-label="Refresh ACP context" onClick={() => setRevision((value) => value + 1)} className="rounded p-2 hover:bg-raised"><RefreshCw size={18} /></button>
            <button aria-label="Close ACP context" onClick={onClose} className="rounded p-2 hover:bg-raised"><X size={18} /></button>
          </div>
        </header>
        <p className="my-3 text-sm text-ink-secondary">App-wide context and bot-specific persona/SOUL are independently configured below. Exact input is saved before dispatch. The agent owns its native system prompt, project instructions and tools.</p>
        <div className="overflow-auto">
          {error && <p role="alert" className="text-danger">{error}</p>}
          {!receipts && !error && <p>Loading…</p>}
          {view && <AcpContextControls key={`${botId}:${threadId}`} botId={botId} threadId={threadId} view={view} onSaved={setView} />}
          {receipts?.length === 0 && <p className="text-sm text-ink-secondary">No messages dispatched in this conversation yet. App awareness and bot profiles are enabled by default.</p>}
          {receipts?.slice().reverse().map((receipt, index) => (
            <details key={receipt.id} open={index === 0} className="mb-3 rounded-lg border border-hairline p-3 text-sm">
              <summary className="cursor-pointer text-ink">{receipt.at} · {receipt.status} · {receipt.model}</summary>
              <dl className="my-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 break-all text-xs text-ink-secondary">
                <dt>Session</dt><dd>{receipt.sessionId}</dd><dt>Working folder</dt><dd>{receipt.cwd}</dd><dt>Mode</dt><dd>{receipt.mode}</dd>
                <dt>Extra context</dt><dd>{receipt.instructions || "None"}</dd>
                {receipt.nativeSettings && <><dt>Native options</dt><dd>{JSON.stringify(receipt.nativeSettings)}</dd></>}
                {receipt.connectedTools && <><dt>App-selected tools</dt><dd>{JSON.stringify(receipt.connectedTools)}</dd></>}
                {receipt.connectedToolCalls?.length ? <><dt>Connected app calls</dt><dd>{JSON.stringify(receipt.connectedToolCalls)}</dd></> : null}
              </dl>
              {receipt.context && <details className="mb-3"><summary className="cursor-pointer">Dispatched context manifest</summary><ContextSections sections={receipt.context.sections} /></details>}
              {receipt.prompt.map((block, blockIndex) => block.type === "text"
                ? <pre key={blockIndex} data-testid="acp-input-text" className="mb-2 whitespace-pre-wrap break-words rounded bg-inset p-3 font-mono text-xs text-ink">{block.text}</pre>
                : <p key={blockIndex}>Image · {block.mimeType} · {block.data.length} base64 characters</p>)}
              {receipt.error && <p className="text-danger">{receipt.error}</p>}
            </details>
          ))}
        </div>
      </section>
    </div>
  );
}
