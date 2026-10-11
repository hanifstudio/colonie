/** React wrapper for the pinned MIT Bloub engine; see third_party/bloub. */
import { forwardRef, memo, useEffect, useId, useImperativeHandle, useRef, useState } from "react";
import { BotEngine, type BotFrame } from "../../third_party/bloub/src/bot/engine";
import { SHAPE_BY_ID } from "../../third_party/bloub/src/bot/skins";
import { EXPRESSION_BY_ID, EXPRESSIONS } from "../../third_party/bloub/src/bot/expressions";
import { NOTIF_BLUE } from "../../third_party/bloub/src/bot/decor";
import { bloubViewHalf, useGlobalBloubGaze } from "./bloub-gaze";
import type { StateId } from "../../third_party/bloub/src/bot/states";
import type { MausAvatarHandle, MausAvatarProps } from "./Avatar";

const SHAPES: Record<string, string> = { cursor: "galet", blob: "galet", circle: "cercle", squircle: "squircle", capsule: "capsule", drop: "goutte", shield: "goutte", hexagon: "hexagone", diamond: "squircle", star: "nuage" };
const FACES: Record<string, string> = { happy: "heureux", proud: "fier", sad: "triste", scared: "effraye", suspicious: "mefiant", confused: "confus", curious: "curieux", surprised: "surpris", angry: "colere", drowsy: "somnolent", listening: "attentif", excited: "excite", shy: "timide", bored: "blase" };
// Body inks. Deeper and more saturated than the earlier pastel set so the
// light `#fcfaff` eyes read clearly: every tone now holds >= 3:1 against the
// eyes (WCAG non-text minimum; the old set sat at 1.6-3.5:1).
const COLORS: Record<string, string> = { green: "#1f8a5b", purple: "#6d4ae0", blue: "#2f74c9", cyan: "#1f8f99", red: "#cf4258", pink: "#c74b86", orange: "#c86a1c", yellow: "#a8841a", teal: "#1f8a80", coral: "#c85a41" };

export function bloubState(state = "idle", motion = "none"): StateId {
  if (motion === "failure") return "alert";
  if (["success", "blink", "customize"].includes(motion)) return "wink";
  if (motion === "celebrate") return "burst";
  if (["alerting", "notifying"].includes(state)) return "notify";
  if (["sleeping", "drowsy", "powering-down"].includes(state)) return "sleep";
  if (["thinking", "searching", "radar"].includes(state)) return "thinking";
  if (["working", "writing", "loading", "uploading", "progress", "orbit"].includes(state)) return "orbit";
  if (["spawning", "waking"].includes(state)) return "swirl";
  if (["sending", "receiving"].includes(state)) return "comet";
  if (["surprised", "scared"].includes(state)) return "wide";
  return "idle";
}
export function bloubShape(body = "cursor") { return SHAPE_BY_ID.get(SHAPES[body] ?? "galet")!; }

export function BloubFrame({ frame, size, ink, uid, label }: { frame: BotFrame; size: number; ink: string; uid: string; label?: string }) {
  const dots = frame.dots.map((dot, index) => dot.d
    ? <path key={index} d={dot.d} transform={`translate(${dot.x} ${dot.y}) rotate(${dot.rot ?? 0}) scale(100)`} fill={dot.color ?? ink} opacity={dot.opacity} />
    : <circle key={index} cx={dot.x} cy={dot.y} r={dot.r} fill={dot.color ?? ink} opacity={dot.opacity} />);
  // Presentation-only camera: the tight window at rest makes the body ~1.3x
  // larger without touching engine geometry; the full window returns while
  // orbit/comet decor is visibly drawn (see bloub-frame-fit.test.ts). The
  // mask keeps full-viewBox coordinates — a larger mask than the visible
  // window is harmless.
  const half = bloubViewHalf(frame.arcs);
  return (
    <svg width={size} height={size} viewBox={`${-half} ${-half} ${half * 2} ${half * 2}`} role="img" aria-label={label ?? "Colonie agent"} data-mascot="bloub">
      <defs>
        <mask id={`${uid}-mask`} maskUnits="userSpaceOnUse" x={-158} y={-158} width={316} height={316}>
          <path d={frame.bodyPath} fill="white" />
          {frame.eyes.map((eye, index) => <path key={index} d={eye.d} transform={eye.matrix} opacity={eye.alpha} fill="black" />)}
          {frame.notch && <circle cx={frame.notch.x} cy={frame.notch.y} r={frame.notch.r} fill="black" />}
        </mask>
        {frame.arcs.map((arc) => <linearGradient key={arc.id} id={`${uid}-${arc.id}`} gradientUnits="userSpaceOnUse" x1={arc.grad.x1} y1={arc.grad.y1} x2={arc.grad.x2} y2={arc.grad.y2}>
          {arc.grad.stops.map((color, index) => <stop key={index} offset={index / (arc.grad.stops.length - 1)} stopColor={color} />)}
        </linearGradient>)}
      </defs>
      <g fill="none" strokeLinecap="round">{frame.arcs.map((arc) => <path key={arc.id} d={arc.back} stroke={`url(#${uid}-${arc.id})`} strokeWidth={arc.width} opacity={arc.opacity} />)}</g>
      {frame.dotsBehind && dots}
      <g opacity={frame.bodyAlpha}>
        <path d={frame.bodyPath} fill="#fcfaff" />
        <rect x={-158} y={-158} width={316} height={316} fill={ink} mask={`url(#${uid}-mask)`} />
      </g>
      {!frame.dotsBehind && dots}
      {frame.notif && <circle cx={frame.notif.x} cy={frame.notif.y} r={frame.notif.r} fill={NOTIF_BLUE} />}
      <g fill="none" strokeLinecap="round">{frame.arcs.map((arc) => <path key={arc.id} d={arc.front} stroke={`url(#${uid}-${arc.id})`} strokeWidth={arc.width} opacity={arc.opacity} />)}</g>
    </svg>
  );
}

export const BloubAvatar = memo(forwardRef<MausAvatarHandle, MausAvatarProps>(function BloubAvatar(props, ref) {
  const uid = `colonie-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const element = useRef<HTMLSpanElement>(null);
  const clock = useRef(1);
  const state = bloubState(props.state, props.motion);
  const expression = typeof props.expression === "number" ? EXPRESSIONS[props.expression % EXPRESSIONS.length]
    : EXPRESSION_BY_ID.get(FACES[props.state ?? "idle"] ?? "curieux");
  const engineRef = useRef<BotEngine | null>(null);
  engineRef.current ??= new BotEngine(100, state, bloubShape(props.bodyId).radii, expression ?? null);
  const engine = engineRef.current;
  const [frame, setFrame] = useState(() => engine.sample(1));
  // Global gaze replaces the local hover handlers below: while it is on, a
  // `pointerleave` of the small avatar box must NOT rest the eyes, because
  // the pointer is usually still inside the window and the next global
  // `pointermove` keeps the stare alive.
  const globalGaze = props.followGlobalPointer === true
    && props.trackPointer !== false && props.animated !== false;
  const canHover = props.trackPointer !== false && props.animated !== false && !globalGaze;
  useGlobalBloubGaze({
    enabled: globalGaze,
    elementRef: element,
    onGaze: (yaw, pitch) => {
      engine.setLook({ yaw, pitch, mix: 1, spin: 0, wander: 0 }, clock.current);
    },
    onRest: () => {
      engine.setLook(null, clock.current);
    },
  });
  useImperativeHandle(ref, () => ({ blink: () => engine.setState("wink", clock.current), spin: () => engine.setState("swirl", clock.current), setExpression: (index) => engine.setExpression(EXPRESSIONS[index % EXPRESSIONS.length] ?? null, clock.current) }), [engine]);
  useEffect(() => {
    engine.setShape(bloubShape(props.bodyId).radii, clock.current);
    engine.setExpression(expression ?? null, clock.current);
    engine.setState(state, clock.current);
    if (props.animated === false || window.matchMedia("(prefers-reduced-motion: reduce)").matches) clock.current += 1;
    setFrame({ ...engine.sample(clock.current) });
  }, [engine, state, expression, props.bodyId, props.animated]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    let raf = 0; let visible = true; let last = 0;
    const paint = (now: number) => {
      if (last) clock.current += Math.min((now - last) / 1000, 0.1);
      last = now; setFrame({ ...engine.sample(clock.current) });
      raf = requestAnimationFrame(paint);
    };
    const update = () => {
      cancelAnimationFrame(raf); last = 0;
      setFrame({ ...engine.sample(clock.current) });
      if (props.animated !== false && !media.matches && visible && document.visibilityState !== "hidden") raf = requestAnimationFrame(paint);
    };
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(([entry]) => { visible = Boolean(entry?.isIntersecting); update(); });
    if (element.current) observer?.observe(element.current);
    media.addEventListener("change", update); document.addEventListener("visibilitychange", update); update();
    return () => { cancelAnimationFrame(raf); observer?.disconnect(); media.removeEventListener("change", update); document.removeEventListener("visibilitychange", update); };
  }, [engine, props.animated]);
  return <span ref={element} className="inline-flex shrink-0" onPointerMove={canHover ? (event) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width && box.height) engine.setLook({ yaw: ((event.clientX - box.left) / box.width - 0.5) * 40, pitch: -((event.clientY - box.top) / box.height - 0.5) * 25, mix: 1, spin: 0, wander: 0 }, clock.current);
  } : undefined} onPointerLeave={globalGaze ? undefined : () => engine.setLook(null, clock.current)}>
    <BloubFrame frame={frame} size={props.size ?? 44} ink={COLORS[props.color] ?? COLORS.green!} uid={uid} label={props.label} />
  </span>;
}));
