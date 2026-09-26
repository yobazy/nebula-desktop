// Project icons: the one picked for a project, else the repo's own logo if
// it keeps one where projects usually do, else a monogram. Picks live in the
// desktop app's prefs (the TUI has no use for them), images as data URLs so
// moving the original file doesn't lose the icon.
import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isPreview } from "./client";
import { getState, setState, subscribe } from "./store";
import { savePrefs, type ProjectIconChoice } from "./theme";
import type { Project } from "./types";

export type ShownIcon = ProjectIconChoice | { kind: "monogram"; value: string; hue: number };

/** A steady hue per project name, so each monogram keeps its color. */
function hueOf(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
}

export function iconFor(project: Project, picked: Record<string, ProjectIconChoice> | undefined, logos: Record<string, string | null>): ShownIcon {
  const choice = picked?.[project.repo_path];
  if (choice) return choice;
  const logo = logos[project.repo_path];
  if (logo) return { kind: "image", value: logo };
  const letter = [...project.name.replace(/^[^\p{L}\p{N}]+/u, "")][0]?.toUpperCase() ?? "?";
  return { kind: "monogram", value: letter, hue: hueOf(project.name) };
}

export async function setProjectIcon(repo: string, choice: ProjectIconChoice | null) {
  const prefs = getState().prefs;
  const projectIcons = { ...(prefs.projectIcons ?? {}) };
  if (choice) projectIcons[repo] = choice;
  else delete projectIcons[repo];
  await savePrefs({ ...prefs, projectIcons });
}

/** Pick an image file for an icon; null when the picker is cancelled. */
export async function pickIconImage(): Promise<string | null> {
  if (isPreview()) return previewLogo("#5fd4b0", "◆");
  const { open } = await import("@tauri-apps/plugin-dialog");
  const path = await open({
    title: "Choose an icon",
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "ico"] }],
  });
  if (typeof path !== "string") return null;
  return invoke<string>("read_icon", { path });
}

function previewLogo(color: string, glyph: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="${color}"/><text x="16" y="22" font-size="16" text-anchor="middle" fill="white" font-family="sans-serif">${glyph}</text></svg>`;
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
}

async function findLogo(repo: string): Promise<string | null> {
  if (isPreview()) {
    // A couple of the demo projects "keep" a logo, to show the mix.
    if (repo.endsWith("/storefront")) return previewLogo("#7c5cff", "S");
    if (repo.endsWith("/mobile-app")) return previewLogo("#f2804b", "▲");
    return null;
  }
  return invoke<string | null>("project_logo", { repo });
}

/** Mount once: looks for each project's own logo as projects appear. */
export function useProjectLogos() {
  useEffect(() => {
    const asked = new Set<string>();
    const check = () => {
      for (const p of Object.values(getState().projects)) {
        if (asked.has(p.repo_path)) continue;
        asked.add(p.repo_path);
        void findLogo(p.repo_path).then((logo) =>
          setState((s) => ({ logos: { ...s.logos, [p.repo_path]: logo } })),
        );
      }
    };
    check();
    return subscribe(check);
  }, []);
}
