import { useEffect, useRef, useState } from "react";

const MIN_WIDTH = 340;
let preferredWidth = 540;

/** Leave room to write in chat; a narrow window uses the panel's mobile overlay. */
export function usePreviewPanel() {
  const panel = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const [width, setWidth] = useState(preferredWidth);
  const [maximum, setMaximum] = useState(800);
  useEffect(() => {
    const element = panel.current;
    const main = element?.parentElement?.querySelector("main");
    if (!element || !main) return;
    const read = () => setMaximum(Math.max(MIN_WIDTH, Math.min(800, main.getBoundingClientRect().width + element.getBoundingClientRect().width - 360)));
    read();
    const observer = new ResizeObserver(read);
    observer.observe(main);
    return () => observer.disconnect();
  }, []);
  const change = (value: number) => {
    preferredWidth = Math.max(MIN_WIDTH, Math.min(maximum, value));
    setWidth(preferredWidth);
  };
  return {
    panel, width: Math.min(width, maximum), minimum: MIN_WIDTH, maximum,
    resize: {
      onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
        if (event.button !== 0) return;
        event.preventDefault();
        drag.current = { x: event.clientX, width: Math.min(width, maximum) };
        event.currentTarget.setPointerCapture(event.pointerId);
      },
      onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
        if (drag.current) change(drag.current.width + drag.current.x - event.clientX);
      },
      onPointerUp(event: React.PointerEvent<HTMLDivElement>) {
        drag.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      },
      onPointerCancel() { drag.current = null; },
      onLostPointerCapture() { drag.current = null; },
      onDoubleClick() { change(540); },
      onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
        const next = event.key === "ArrowLeft" ? Math.min(width, maximum) + 24 : event.key === "ArrowRight" ? Math.min(width, maximum) - 24 : event.key === "Home" ? MIN_WIDTH : event.key === "End" ? maximum : null;
        if (next === null || event.metaKey || event.ctrlKey || event.altKey) return;
        event.preventDefault(); change(next);
      },
    },
  };
}
