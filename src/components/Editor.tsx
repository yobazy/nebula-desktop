import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isPreview } from "../nebula/client";
import { flash, getState, useAppState } from "../nebula/store";
import type { Worktree } from "../nebula/types";

let editors: Promise<string[]> | null = null;
/** The same list once it's in, for callers that can't wait (the palette). */
let known: string[] = [];

/** The code editors installed on this Mac (editor.rs), looked up once. */
export function installedEditors(): Promise<string[]> {
  editors ??= (
    isPreview()
      ? Promise.resolve(["Cursor", "Visual Studio Code", "Zed"])
      : invoke<{ name: string }[]>("list_editors")
          .then((l) => l.map((e) => e.name))
          .catch(() => [])
  ).then((l) => (known = l));
  return editors;
}

/** The editor to use right now, from the list as far as it's known. */
export function currentEditor(): string | null {
  return chosenEditor(known);
}

export function useEditors(): string[] {
  const [list, setList] = useState<string[]>([]);
  useEffect(() => void installedEditors().then(setList), []);
  return list;
}

/** The editor to open checkouts in: the one picked in Settings if it's
 *  still installed, else the first found. */
export function chosenEditor(list: string[]): string | null {
  const pref = getState().prefs.editor;
  return pref && list.includes(pref) ? pref : (list[0] ?? null);
}

export async function openInEditor(wt: Worktree, app: string) {
  if (isPreview()) {
    flash(`Opened ${wt.branch} in ${app}`);
    return;
  }
  try {
    await invoke("open_in_editor", { path: wt.path, app });
  } catch (e) {
    flash(e instanceof Error ? e.message : String(e));
  }
}

/** A band's Open in editor. Hidden when no known editor is installed. */
export function EditorButton({ worktree }: { worktree: Worktree }) {
  useAppState();
  const list = useEditors();
  const app = chosenEditor(list);
  if (!app) return null;
  return (
    <button
      className="icon-btn"
      title={`Open ${worktree.branch} in ${app}`}
      aria-label={`Open ${worktree.branch} in ${app}`}
      onClick={() => void openInEditor(worktree, app)}
    >
      <CodeGlyph />
    </button>
  );
}

function CodeGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
      <path
        d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
