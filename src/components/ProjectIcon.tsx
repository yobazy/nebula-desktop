import { useEffect, useRef, useState } from "react";
import { isPreview } from "../nebula/client";
import {
  colorOf,
  iconFor,
  pickIconImage,
  setProjectColor,
  setProjectIcon,
  type ShownIcon,
} from "../nebula/icons";
import { flash, useAppState } from "../nebula/store";
import type { Project } from "../nebula/types";
import { ContextMenu, type MenuItem } from "./Menu";
import { ColorRow } from "./Organize";
import { resetProjectOrder } from "../nebula/organize";

export function ProjectIcon({ project, size = 18 }: { project: Project; size?: number }) {
  const { prefs, logos } = useAppState();
  return <IconView icon={iconFor(project, prefs.projectIcons, logos, prefs.projectColors)} size={size} />;
}

function IconView({ icon, size }: { icon: ShownIcon; size: number }) {
  const style = { width: size, height: size, fontSize: Math.round(size * 0.62) };
  if (icon.kind === "image") return <img className="picon" src={icon.value} alt="" style={style} draggable={false} />;
  if (icon.kind === "emoji")
    return (
      <span className="picon picon-emoji" style={{ ...style, fontSize: Math.round(size * 0.8) }} aria-hidden>
        {icon.value}
      </span>
    );
  return (
    <span className="picon picon-mono" style={{ ...style, "--hue": icon.hue } as React.CSSProperties} aria-hidden>
      {icon.value}
    </span>
  );
}

const EMOJI = ["🚀", "🛒", "🧪", "📦", "🧠", "⚙️", "🎨", "📱", "💳", "🌐", "📊", "🔒", "🐛", "✨", "🔥", "🌙", "⭐", "🧩", "📝", "🎵", "🎮", "🤖", "💡", "🏗️"];

/** The first character a person would see in `text` (so a flag or a
 *  skin-toned emoji stays whole). */
function firstGrapheme(text: string): string {
  const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return seg.segment(text.trim())[Symbol.iterator]().next().value?.segment ?? "";
}

/** Pick an emoji or an image and a color for a project, or go back to its defaults. */
export function IconPicker({ project, onClose }: { project: Project; onClose: () => void }) {
  const { prefs, logos } = useAppState();
  const picked = prefs.projectIcons?.[project.repo_path];
  const color = prefs.projectColors?.[project.repo_path] ?? null;
  const logo = logos[project.repo_path];
  const [typed, setTyped] = useState("");
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialog.current?.querySelector<HTMLElement>("button")?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const choose = (value: Parameters<typeof setProjectIcon>[1]) =>
    void setProjectIcon(project.repo_path, value).catch((e) => flash(`Couldn't save the icon: ${e}`));

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialog} className="dialog dialog-narrow icon-picker" role="dialog" aria-modal="true" aria-labelledby="icon-title">
        <header className="icon-picker-head">
          <ProjectIcon project={project} size={40} />
          <h2 id="icon-title">{project.name}</h2>
        </header>

        <div className="picker-section" id="color-label">
          Color
        </div>
        <ColorRow
          value={color}
          labelledBy="color-label"
          onPick={(name) => void setProjectColor(project.repo_path, name).catch((e) => flash(String(e)))}
        />

        <div className="picker-section">Icon</div>
        <div className="emoji-grid" role="group" aria-label="Emoji">
          {EMOJI.map((e) => (
            <button
              key={e}
              className={`emoji-cell${picked?.kind === "emoji" && picked.value === e ? " is-on" : ""}`}
              onClick={() => choose({ kind: "emoji", value: e })}
              aria-label={`Use ${e}`}
            >
              {e}
            </button>
          ))}
        </div>

        <form
          className="emoji-typed"
          onSubmit={(ev) => {
            ev.preventDefault();
            const g = firstGrapheme(typed);
            if (g) choose({ kind: "emoji", value: g });
            setTyped("");
          }}
        >
          <input
            className="setting-input"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Or type any emoji (⌃⌘Space opens the picker)"
            aria-label="Any emoji"
          />
          <button type="submit" className="btn" disabled={!typed.trim()}>
            Use
          </button>
        </form>

        <div className="icon-picker-actions">
          <button
            className="btn"
            onClick={async () => {
              try {
                const img = await pickIconImage();
                if (img) choose({ kind: "image", value: img });
              } catch (e) {
                flash(String(e));
              }
            }}
          >
            Choose image…
          </button>
          {logo && picked && (
            <button className="btn" onClick={() => choose(null)}>
              Use the repo’s logo
            </button>
          )}
          {picked && !logo && (
            <button className="btn" onClick={() => choose(null)}>
              Reset
            </button>
          )}
        </div>

        <footer className="dialog-foot">
          <span className="hint">
            {logo ? "Without a pick, the repo’s own logo shows." : "Without a pick, a letter shows."}
          </span>
          <button className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}

/** The project row's right-click menu, and the icon picker it opens. */
export function useProjectMenu() {
  const [menu, setMenu] = useState<{ items: MenuItem[]; x: number; y: number; label: string } | null>(null);
  const [picking, setPicking] = useState<Project | null>(null);
  const { prefs } = useAppState();

  const openFor = (e: React.MouseEvent, project: Project) => {
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const items: MenuItem[] = [{ label: "Icon & color…", run: () => setPicking(project) }];
    if (prefs.projectIcons?.[project.repo_path] || prefs.projectColors?.[project.repo_path]) {
      items.push({
        label: "Reset icon & color",
        run: () => void setProjectIcon(project.repo_path, null).then(() => setProjectColor(project.repo_path, null)),
      });
    }
    if (prefs.projectOrder?.length) {
      items.push({
        label: "Reset project order",
        run: () => void resetProjectOrder().catch((err) => flash(String(err))),
      });
    }
    items.push({
      label: "Show in Finder",
      separated: true,
      run: async () => {
        if (isPreview()) return flash(`Showed ${project.repo_path}`);
        const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
        await revealItemInDir(project.repo_path).catch((err) => flash(String(err)));
      },
    });
    setMenu({ items, x: e.clientX || r.left + 24, y: e.clientY || r.bottom, label: `${project.name} actions` });
  };

  const element = (
    <>
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
      {picking && <IconPicker project={picking} onClose={() => setPicking(null)} />}
    </>
  );
  return { openFor, element };
}

/** A project's color as CSS custom properties (`--pc`, the hue), or
 *  nothing when it has none. */
export function useProjectColorStyle(project: Project | undefined): React.CSSProperties | undefined {
  const { prefs } = useAppState();
  const hue = project ? colorOf(project, prefs.projectColors) : null;
  return hue === null ? undefined : ({ "--pc": hue } as React.CSSProperties);
}
