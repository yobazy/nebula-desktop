import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface MenuItem {
  label: string;
  run: () => void;
  /** Deletes or closes something: shown in the warning color, last. */
  destructive?: boolean;
  /** A rule above this item, between groups. */
  separated?: boolean;
  /** Its shortcut where the menu was opened, shown at the right. */
  keys?: string;
}

/** A context menu at the pointer, the way macOS menus behave: arrow keys
 *  move, Enter picks, Esc, a click elsewhere, a scroll or losing the window
 *  closes it. Kept inside the window near its edges. */
export function ContextMenu({
  items,
  x,
  y,
  label,
  onClose,
}: {
  items: MenuItem[];
  x: number;
  y: number;
  label: string;
  onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ left: x, top: y });
  const [hover, setHover] = useState(0);

  useLayoutEffect(() => {
    const el = menu.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setAt({
      left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)),
    });
    el.focus();
  }, [x, y]);

  useEffect(() => {
    const away = (e: Event) => {
      if (!menu.current?.contains(e.target as Node)) onClose();
    };
    const close = () => onClose();
    window.addEventListener("mousedown", away, true);
    window.addEventListener("contextmenu", away, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    document.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("mousedown", away, true);
      window.removeEventListener("contextmenu", away, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      document.removeEventListener("scroll", close, true);
    };
  }, [onClose]);

  const pick = (i: number) => {
    onClose();
    items[i].run();
  };

  return (
    <div
      ref={menu}
      className="menu"
      role="menu"
      aria-label={label}
      tabIndex={-1}
      style={{ left: at.left, top: at.top }}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") setHover((h) => (h + 1) % items.length);
        else if (e.key === "ArrowUp") setHover((h) => (h - 1 + items.length) % items.length);
        else if (e.key === "Home") setHover(0);
        else if (e.key === "End") setHover(items.length - 1);
        else if (e.key === "Enter" || e.key === " ") pick(hover);
        else if (e.key === "Escape" || e.key === "Tab") onClose();
        else {
          // An item's own shortcut picks it from the open menu too.
          if (e.metaKey || e.ctrlKey || e.altKey) return;
          const i = items.findIndex((it) => it.keys && it.keys.toLowerCase() === e.key.toLowerCase());
          if (i < 0) return;
          pick(i);
        }
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {items.map((item, i) => (
        <div key={item.label} role="none">
          {item.separated && <div className="menu-rule" role="separator" />}
          <button
            role="menuitem"
            tabIndex={-1}
            className={`menu-item${i === hover ? " is-hover" : ""}${item.destructive ? " is-destructive" : ""}`}
            onMouseEnter={() => setHover(i)}
            onClick={() => pick(i)}
          >
            {item.label}
            {item.keys && <kbd className="menu-keys">{item.keys}</kbd>}
          </button>
        </div>
      ))}
    </div>
  );
}
