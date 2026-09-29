import { memo, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { getState, subscribe, waitingAgents } from "../nebula/store";
import { onPetMood } from "../nebula/delight";
import { CAT_W, H, SCALE, step, TICK_MS, W, type Cat, type Frame } from "./petBrain";

// A pixel cat that lives along the bottom of the sidebar, VS Code Pets
// style: it wanders, sits, naps, and chases a ball of yarn in the theme's
// accent. A click gets a heart; an agent that starts waiting on you gets its
// attention. Frames face right and are mirrored for walking left.

type Px = "." | "O" | "D" | "W" | "K" | "P";
const COLORS: Record<Exclude<Px, ".">, string> = {
  O: "#f2a65a", // fur
  D: "#c8742f", // stripes
  W: "#fff1de", // muzzle, chest, paws
  K: "#1b2233", // eyes
  P: "#ff9eb5", // nose
};

const FRAMES = {
  stand: [
    "............O..O..",
    "...........OOOOOO.",
    "..O........OKOOKO.",
    ".O.........OOOPOO.",
    ".O..OOOOOOOWWWWWO.",
    ".OOOODOODOOOOWWO..",
    "..OOOOOOOOOOOOOO..",
    "...ODOODOODOOOO...",
    "...OOOOOOOOOOOO...",
    "...OO.OO...OO.OO..",
    "...OO.OO...OO.OO..",
    "...WW.WW...WW.WW..",
  ],
  walkA: [
    "............O..O..",
    "...........OOOOOO.",
    "..O........OKOOKO.",
    ".O.........OOOPOO.",
    ".O..OOOOOOOWWWWWO.",
    ".OOOODOODOOOOWWO..",
    "..OOOOOOOOOOOOOO..",
    "...ODOODOODOOOO...",
    "...OOOOOOOOOOOO...",
    "..OO...OO.OO...OO.",
    ".OO.....OOO.....OO",
    ".WW......WW.....WW",
  ],
  walkB: [
    "............O..O..",
    "...........OOOOOO.",
    "..O........OKOOKO.",
    ".O.........OOOPOO.",
    ".O..OOOOOOOWWWWWO.",
    ".OOOODOODOOOOWWO..",
    "..OOOOOOOOOOOOOO..",
    "...ODOODOODOOOO...",
    "...OOOOOOOOOOOO...",
    "....OOOO...OOOO...",
    "....OO.OO..OO.OO..",
    "....WW..WW.WW..WW.",
  ],
  sit: [
    "..........O..O....",
    ".........OOOOOO...",
    ".........OKOOKO...",
    ".........OOOPOO...",
    ".........WWWWWW...",
    "..........OWWO....",
    ".O.......OOWWOO...",
    ".O......OOOWWOOO..",
    "..O.....ODOOOODO..",
    "...O....OOOOOOOO..",
    "....OOOOOOOOOOOO..",
    "........WW....WW..",
  ],
  blink: [
    "..........O..O....",
    ".........OOOOOO...",
    ".........OOOOOO...",
    ".........OKKOKKO..",
    ".........WWPWWW...",
    "..........OWWO....",
    ".O.......OOWWOO...",
    ".O......OOOWWOOO..",
    "..O.....ODOOOODO..",
    "...O....OOOOOOOO..",
    "....OOOOOOOOOOOO..",
    "........WW....WW..",
  ],
  pounce: [
    "..............O..O",
    ".............OOOOO",
    "..O..........OKOOK",
    ".O...........OOOPO",
    ".O....OOOOOOOWWWWW",
    ".OOOOODOODOOOOWWO.",
    "..OOOOOOOOOOOOOOWW",
    "...ODOODOODOOOO.WW",
    "...OOOOOOOOOOOO...",
    "...OO.OO..........",
    "..OO..OO..........",
    "..WW..WW..........",
  ],
  sleep: [
    "..................",
    "..................",
    "..................",
    "..................",
    "..........O..O....",
    ".........OOOOOO...",
    ".........OKKOKKO..",
    "...OOOOOOOOOPOOO..",
    "..OOODOODOOWWWWO..",
    ".OOOOOOOOOOOOOOO..",
    ".OODOODOODOOOOO...",
    "..OOOOOOOOOOOOO...",
  ],
} satisfies Record<Frame, string[]>;

function Sprite({ frame }: { frame: Frame }) {
  const rects = useMemo(() => {
    const out: JSX.Element[] = [];
    FRAMES[frame].forEach((row, y) => {
      [...row].forEach((c, x) => {
        if (c !== ".") out.push(<rect key={`${x}-${y}`} x={x} y={y} width="1.02" height="1.02" fill={COLORS[c as Exclude<Px, ".">]} />);
      });
    });
    return out;
  }, [frame]);
  return (
    <svg width={CAT_W} height={H * SCALE} viewBox={`0 0 ${W} ${H}`} shapeRendering="crispEdges" aria-hidden>
      {rects}
    </svg>
  );
}

const BUBBLE_TEXT: Record<NonNullable<Cat["bubble"]>, string> = {
  heart: "♥",
  "!": "!",
  z: "z",
  note: "♪",
  star: "✦",
  sweat: "💧",
};

/** `on` comes from the sidebar, so the store's churn doesn't re-render the
 *  cat: it redraws on its own ticks. */
export const Pet = memo(function Pet({ on }: { on: boolean }) {
  const yard = useRef<HTMLDivElement>(null);
  const width = useRef(200);
  const reduced = useMemo(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches, []);
  const [cat, setCat] = useState<Cat>({
    x: 12,
    dir: 1,
    mode: "sit",
    left: 20,
    frame: "sit",
    step: 0,
    bubble: null,
    bubbleLeft: 0,
    ball: null,
  });

  useEffect(() => {
    if (!on || !yard.current) return;
    const el = yard.current;
    const ro = new ResizeObserver(() => (width.current = el.clientWidth));
    ro.observe(el);
    width.current = el.clientWidth;
    if (reduced) return () => ro.disconnect();
    const t = setInterval(() => {
      if (!document.hidden) setCat((c) => step(c, width.current));
    }, TICK_MS);
    return () => {
      clearInterval(t);
      ro.disconnect();
    };
  }, [on, reduced]);

  // An agent that starts waiting on you gets the cat's attention — not the
  // ones already waiting when the app connects.
  useEffect(() => {
    let waiting = waitingAgents(getState()).length;
    let snapshots = getState().snapshots;
    return subscribe(() => {
      const s = getState();
      const now = waitingAgents(s).length;
      if (s.snapshots !== snapshots) snapshots = s.snapshots;
      else if (now > waiting) {
        setCat((c) => ({ ...c, mode: "alert", left: 30, ball: null, bubble: "!", bubbleLeft: 20 }));
      }
      waiting = now;
    });
  }, []);

  // What happens in the app shows on the cat: a finished turn or a push
  // gets a note, a merge a party, red CI a nervous sweat.
  useEffect(
    () =>
      onPetMood((mood) =>
        setCat((c) =>
          // An agent waiting on you outranks good news: keep the "!".
          c.mode === "alert" && mood !== "party"
            ? c
            : mood === "party"
            ? { ...c, mode: "party", left: 28, ball: null, bubble: "star", bubbleLeft: 28 }
            : mood === "happy"
              ? { ...c, mode: c.mode === "sleep" ? "sit" : c.mode, left: c.mode === "sleep" ? 30 : c.left, bubble: "note", bubbleLeft: 14 }
              : { ...c, mode: "sit", left: 40, ball: null, bubble: "sweat", bubbleLeft: 24 },
        ),
      ),
    [],
  );

  if (!on) return null;
  const facingLeft = cat.dir === -1;
  return (
    <div className="pet-yard" ref={yard}>
      {cat.ball && (
        <span className="pet-ball" style={{ transform: `translateX(${cat.ball.x}px)` }} aria-hidden>
          <svg width="8" height="8" viewBox="0 0 4 4" shapeRendering="crispEdges">
            <rect x="1" y="0" width="2" height="4" fill="var(--accent)" />
            <rect x="0" y="1" width="4" height="2" fill="var(--accent)" />
            <rect x="1" y="1" width="1" height="1" fill="#ffffff" opacity="0.7" />
          </svg>
        </span>
      )}
      <button
        className="pet-cat"
        style={{ transform: `translateX(${cat.x}px)` }}
        onClick={() =>
          setCat((c) => ({
            ...c,
            mode: c.mode === "sleep" ? "sit" : c.mode,
            left: c.mode === "sleep" ? 30 : c.left,
            bubble: "heart",
            bubbleLeft: 12,
          }))
        }
        aria-label="The sidebar cat. Click to pet it."
        title="Pet the cat"
      >
        <span className={facingLeft ? "pet-flip" : undefined}>
          <Sprite frame={cat.frame} />
        </span>
        {/* Bubbles clear on the tick, which reduced motion doesn't run. */}
        {cat.bubble && !reduced && (
          <span className={`pet-bubble pet-bubble-${cat.bubble === "!" ? "alert" : cat.bubble}`} aria-hidden>
            {BUBBLE_TEXT[cat.bubble]}
          </span>
        )}
      </button>
    </div>
  );
});
