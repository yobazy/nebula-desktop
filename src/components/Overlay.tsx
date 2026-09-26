import { useEffect, type RefObject } from "react";
import { setState } from "../nebula/store";

/** For a view laid over the sessions and terminal (usage, settings): take
 *  focus from the terminal underneath as it opens — keystrokes must never
 *  reach an agent you can't see — and close on Esc, unless Esc is ending an
 *  edit in one of its own fields. */
export function useOverlayKeys(focusTarget: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const first = focusTarget.current?.querySelector<HTMLElement>("button, [tabindex], input, select");
    (first ?? focusTarget.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      const editing = t instanceof HTMLInputElement || t instanceof HTMLSelectElement;
      if (e.key === "Escape" && !editing) setState({ view: "sessions" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusTarget]);
}
