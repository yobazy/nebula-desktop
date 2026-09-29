import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

/** How far the pointer moves before a press becomes a drag, so a click
 *  still picks the row. */
const SLOP = 5;
/** Within this far of the scroller's edge, a drag scrolls it. */
const EDGE = 36;

interface Drag {
  id: string;
  /** The items' ids as they stood when the press began. */
  ids: string[];
  pointer: number;
  startY: number;
  startScroll: number;
  items: HTMLElement[];
  rects: DOMRect[];
  from: number;
  to: number;
  step: number;
  active: boolean;
  scroller: HTMLElement | null;
  lastY: number;
  frame: number;
  /** Takes down the window listeners this drag put up. */
  off: () => void;
}

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if ((o === "auto" || o === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

/** Press, hold and drag a list's items into a new order, done with pointer
 *  events rather than HTML drag and drop (which the webview draws poorly).
 *  The list's direct children carry `data-reorder-id`; the others slide
 *  aside as the dragged one passes, and `onMove(id, to, ids)` gets the
 *  drop, with the order the user saw. While a drag is on, `frozen` holds
 *  that order: a list that sorts itself should render in it, so rows don't
 *  re-sort under the pointer. */
export function useReorder(onMove: (id: string, to: number, ids: string[]) => void, enabled = true) {
  const list = useRef<HTMLUListElement>(null);
  const drag = useRef<Drag | null>(null);
  const [frozen, setFrozen] = useState<string[] | null>(null);
  const move = useRef(onMove);
  move.current = onMove;

  useEffect(() => () => end(false, true), []);

  function paint(d: Drag) {
    const dy = d.lastY - d.startY + ((d.scroller?.scrollTop ?? 0) - d.startScroll);
    const r = d.rects[d.from];
    const mid = r.top + r.height / 2 + dy;
    let to = d.from;
    d.rects.forEach((o, i) => {
      const m = o.top + o.height / 2;
      if (i > d.from && mid > m) to = i;
      if (i < d.from && mid < m && to >= d.from) to = i;
    });
    d.to = to;
    d.items.forEach((el, i) => {
      if (i === d.from) el.style.transform = `translateY(${dy}px)`;
      else if (i > d.from && i <= to) el.style.transform = `translateY(${-d.step}px)`;
      else if (i < d.from && i >= to) el.style.transform = `translateY(${d.step}px)`;
      else el.style.transform = "";
    });
  }

  /** Scroll while the pointer is near the scroller's edge. */
  function tick() {
    const d = drag.current;
    if (!d?.active) return;
    if (d.scroller) {
      const box = d.scroller.getBoundingClientRect();
      const speed =
        d.lastY < box.top + EDGE ? -(box.top + EDGE - d.lastY) / 3 : d.lastY > box.bottom - EDGE ? (d.lastY - box.bottom + EDGE) / 3 : 0;
      if (speed) {
        d.scroller.scrollTop += speed;
        paint(d);
      }
    }
    d.frame = requestAnimationFrame(tick);
  }

  function onPointerMove(e: PointerEvent) {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointer) return;
    d.lastY = e.clientY;
    if (!d.active) {
      if (Math.abs(e.clientY - d.startY) < SLOP) return;
      d.active = true;
      setFrozen(d.ids);
      document.body.classList.add("is-reordering");
      list.current?.classList.add("is-reordering");
      d.items[d.from].classList.add("is-dragging");
      d.frame = requestAnimationFrame(tick);
    }
    e.preventDefault();
    paint(d);
  }

  /** Swallow the click a release makes, so a drag doesn't also open the
   *  row; cleared after that click would have fired. */
  function swallowClick() {
    const swallow = (e: MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
    };
    window.addEventListener("click", swallow, true);
    setTimeout(() => window.removeEventListener("click", swallow, true), 0);
  }

  /** `escaped`: ended by Esc with the button still down, so its release
   *  (and the click that makes) is still to come. */
  function end(drop: boolean, unmounting = false, escaped = false) {
    const d = drag.current;
    drag.current = null;
    d?.off();
    if (!d?.active) return;
    cancelAnimationFrame(d.frame);
    if (!unmounting) {
      if (drop) swallowClick();
      else if (escaped) {
        const pointer = d.pointer;
        const onUp = (e: PointerEvent) => {
          if (e.pointerId !== pointer) return;
          disarm();
          swallowClick();
        };
        // A release lost to the window (focus moved away) mustn't leave it
        // armed for some later click: the next press disarms it.
        const disarm = () => {
          window.removeEventListener("pointerup", onUp, true);
          window.removeEventListener("pointerdown", disarm, true);
        };
        window.addEventListener("pointerup", onUp, true);
        window.addEventListener("pointerdown", disarm, true);
      }
      // Commit the new order before the offsets come off, so rows don't
      // flash back to where they were.
      flushSync(() => {
        if (drop && d.to !== d.from) move.current(d.id, d.to, d.ids);
        setFrozen(null);
      });
    }
    list.current?.classList.remove("is-reordering");
    document.body.classList.remove("is-reordering");
    d.items.forEach((el) => {
      el.classList.remove("is-dragging");
      el.style.transform = "";
    });
  }

  function onPointerUp(e: PointerEvent) {
    if (e.pointerId === drag.current?.pointer) end(true);
  }
  function onCancel() {
    end(false);
  }
  function onKey(e: KeyboardEvent) {
    if (e.key !== "Escape" || !drag.current?.active) return;
    e.preventDefault();
    e.stopPropagation();
    end(false, false, true);
  }

  /** Spread on each item: `<li {...item(id)}>`. */
  const item = (id: string) => ({
    "data-reorder-id": id,
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      // Ctrl-click is the Mac's right click: leave it to the menu.
      if (!enabled || e.button !== 0 || e.ctrlKey || drag.current || !list.current) return;
      const items = [...list.current.children].filter(
        (el): el is HTMLElement => el instanceof HTMLElement && el.dataset.reorderId !== undefined,
      );
      const from = items.findIndex((el) => el.dataset.reorderId === id);
      if (from < 0 || items.length < 2) return;
      const rects = items.map((el) => el.getBoundingClientRect());
      const next = rects[from + 1] ?? rects[from - 1];
      const gap = from + 1 < rects.length ? next.top - rects[from].bottom : rects[from].top - next.bottom;
      const scroller = scrollParent(list.current);
      drag.current = {
        id,
        ids: items.map((el) => el.dataset.reorderId!),
        pointer: e.pointerId,
        startY: e.clientY,
        lastY: e.clientY,
        startScroll: scroller?.scrollTop ?? 0,
        items,
        rects,
        from,
        to: from,
        step: rects[from].height + Math.max(0, gap),
        active: false,
        scroller,
        frame: 0,
        off: () => {
          window.removeEventListener("pointermove", onPointerMove);
          window.removeEventListener("pointerup", onPointerUp);
          window.removeEventListener("pointercancel", onCancel);
          window.removeEventListener("keydown", onKey, true);
        },
      };
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("keydown", onKey, true);
    },
  });

  return { list, item, frozen };
}

/** ⌥↑ / ⌥↓ on a focused item: the keyboard's way to reorder. */
export function reorderKey(e: React.KeyboardEvent, index: number, count: number, onMove: (to: number) => void) {
  if (!e.altKey || e.metaKey || e.ctrlKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
  const to = index + (e.key === "ArrowUp" ? -1 : 1);
  e.preventDefault();
  if (to < 0 || to >= count) return;
  const target = e.currentTarget as HTMLElement;
  onMove(to);
  // The row re-renders elsewhere in the list; keep focus on it.
  requestAnimationFrame(() => target.focus());
}
