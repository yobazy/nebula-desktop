import { useEffect, useRef, useState } from "react";
import { useOverlayKeys } from "./Overlay";
import { flash, setState, useAppState } from "../nebula/store";
import {
  AGENTS_HEAD,
  EXPERIMENTAL,
  GENERAL,
  harnessRows,
  loadSettings,
  projectSetting,
  SESSIONS,
  THEMES,
  TUI_APPEARANCE,
  value,
  writeProjectSetting,
  writeSetting,
  type Row,
  type Settings,
} from "../nebula/settings";
import { ACCENTS, MODES, resolvedMode, savePrefs, themeName } from "../nebula/theme";
import { sortedProjects } from "../nebula/store";

const TABS = ["Appearance", "General", "Sessions", "Agents", "Project", "Shortcuts", "Experimental"] as const;
type Tab = (typeof TABS)[number];

/** nebula's settings, tab for tab as the TUI lays them out, plus the desktop
 *  app's own look. Every change saves as it's made, to the same files the
 *  TUI reads, so the two apps never disagree. */
export function SettingsView() {
  const [tab, setTab] = useState<Tab>("Appearance");
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    void loadSettings().then(setSettings);
  }, []);

  const tabList = useRef<HTMLElement>(null);
  useOverlayKeys(tabList);

  const save = async (key: string, v: unknown) => {
    setSettings((s) => ({ ...s, [key]: v }));
    if (key === "theme" && typeof v === "string") setState({ theme: v });
    try {
      await writeSetting(key, v);
    } catch (e) {
      flash(`Couldn't save ${key}: ${e instanceof Error ? e.message : String(e)}`);
      setSettings(await loadSettings());
    }
  };

  return (
    <section className="settings" aria-labelledby="settings-title">
      <header className="usage-head" data-tauri-drag-region>
        <div data-tauri-drag-region>
          <h1 id="settings-title">Settings</h1>
          <p className="usage-sub">
            Shared with the nebula TUI: a change here shows up there, and the other way round.
          </p>
        </div>
        <div className="usage-controls">
          <button className="btn btn-sm" onClick={() => setState({ view: "sessions" })} title="Close (Esc)">
            Done
          </button>
        </div>
      </header>
      <div className="settings-body">
        <nav className="settings-tabs" aria-label="Settings sections" ref={tabList}>
          {TABS.map((t) => (
            <button
              key={t}
              className={`settings-tab${tab === t ? " is-on" : ""}`}
              aria-current={tab === t ? "page" : undefined}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </nav>
        <div className="settings-pane">
          {!settings ? (
            <p className="usage-empty">Reading settings…</p>
          ) : tab === "Appearance" ? (
            <Appearance settings={settings} save={save} />
          ) : tab === "General" ? (
            <Rows rows={GENERAL} settings={settings} save={save} />
          ) : tab === "Sessions" ? (
            <Rows rows={SESSIONS} settings={settings} save={save} />
          ) : tab === "Agents" ? (
            <>
              <Rows rows={AGENTS_HEAD} settings={settings} save={save} />
              {harnessRows().map((h) => (
                <Group key={h.title} title={h.title}>
                  <Rows rows={h.rows} settings={settings} save={save} />
                </Group>
              ))}
            </>
          ) : tab === "Project" ? (
            <ProjectTab settings={settings} onChange={() => void loadSettings().then(setSettings)} />
          ) : tab === "Shortcuts" ? (
            <Shortcuts />
          ) : (
            <Rows rows={EXPERIMENTAL} settings={settings} save={save} />
          )}
        </div>
      </div>
    </section>
  );
}

function Group({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="settings-group">
      <h2>
        {title}
        {note && <span className="settings-note">{note}</span>}
      </h2>
      {children}
    </section>
  );
}

function Appearance({ settings, save }: { settings: Settings; save: (k: string, v: unknown) => void }) {
  const { prefs } = useAppState();
  const theme = themeName(settings.theme);
  const shade = resolvedMode(prefs.mode) === "light" ? "light" : "dark";
  return (
    <>
      <Group title="Desktop app">
        <div className="setting">
          <div className="setting-text">
            <span className="setting-label" id="mode-label">
              Appearance
            </span>
            <span className="setting-hint">System follows macOS. Black is pure black, for OLED screens.</span>
          </div>
          <div className="segmented segmented-sm" role="radiogroup" aria-labelledby="mode-label">
            {MODES.map((m) => (
              <button
                key={m.id}
                role="radio"
                aria-checked={(prefs.mode ?? "system") === m.id}
                className={(prefs.mode ?? "system") === m.id ? "is-on" : ""}
                onClick={() => void savePrefs({ ...prefs, mode: m.id })}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
        <div className="setting">
          <div className="setting-text">
            <label className="setting-label" htmlFor="set-pet">
              Sidebar cat
            </label>
            <span className="setting-hint">A pixel cat that plays at the bottom of the sidebar. Click it to say hi.</span>
          </div>
          <Switch id="set-pet" on={prefs.pet !== false} onChange={(on) => void savePrefs({ ...prefs, pet: on })} />
        </div>
        <div className="setting setting-stack">
          <div className="setting-text">
            <span className="setting-label" id="accent-label">
              Color theme
            </span>
            <span className="setting-hint">The accent color, shared with the TUI's theme.</span>
          </div>
          <div className="swatches" role="radiogroup" aria-labelledby="accent-label">
            {THEMES.map((t) => (
              <button
                key={t}
                role="radio"
                aria-checked={theme === t}
                className={`swatch${theme === t ? " is-on" : ""}`}
                onClick={() => save("theme", t)}
              >
                <span className="swatch-dot" style={{ background: ACCENTS[t][shade] }} aria-hidden />
                {t}
              </button>
            ))}
          </div>
        </div>
      </Group>
      <Group title="Terminal app" note="only changes how the TUI looks">
        <Rows rows={TUI_APPEARANCE} settings={settings} save={save} />
      </Group>
    </>
  );
}

function Rows({ rows, settings, save }: { rows: Row[]; settings: Settings; save: (k: string, v: unknown) => void }) {
  return (
    <div className="settings-rows">
      {rows.map((row) => (
        <SettingRow key={row.key} row={row} v={value(settings, row)} save={save} />
      ))}
    </div>
  );
}

function SettingRow({ row, v, save }: { row: Row; v: unknown; save: (k: string, v: unknown) => void }) {
  const id = `set-${row.key}`;
  return (
    <div className="setting">
      <div className="setting-text">
        <label className="setting-label" htmlFor={id}>
          {row.label}
          {row.tui && <span className="setting-tag">TUI</span>}
        </label>
        <span className="setting-hint">{row.hint}</span>
      </div>
      {row.type === "bool" ? (
        <Switch id={id} on={row.invert ? !v : !!v} onChange={(on) => save(row.key, row.invert ? !on : on)} />
      ) : row.type === "choice" ? (
        <select id={id} className="setting-input" value={String(v)} onChange={(e) => save(row.key, e.target.value)}>
          {/* A value set by hand, or by a newer TUI, still shows as itself. */}
          {!row.options.includes(String(v)) && <option value={String(v)}>{String(v)}</option>}
          {row.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : (
        <TextSetting
          id={id}
          value={String(v ?? "")}
          placeholder={row.placeholder}
          suggestions={row.suggestions}
          // Cleared means the default: for model and effort that's the TUI's
          // "default", not an empty string it would treat as a name.
          onCommit={(t) => save(row.key, t === "" && row.def === "default" ? "default" : t)}
        />
      )}
    </div>
  );
}

function Switch({ id, on, onChange }: { id: string; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button id={id} role="switch" aria-checked={on} className={`switch${on ? " is-on" : ""}`} onClick={() => onChange(!on)}>
      <span className="switch-knob" aria-hidden />
    </button>
  );
}

/** A typed value, saved when you press Enter or leave the field. */
function TextSetting({
  id,
  value: initial,
  placeholder,
  suggestions,
  onCommit,
}: {
  id: string;
  value: string;
  placeholder?: string;
  suggestions?: string[];
  onCommit: (v: string) => void;
}) {
  const [text, setText] = useState(initial);
  useEffect(() => setText(initial), [initial]);
  const commit = () => text !== initial && onCommit(text.trim());
  return (
    <>
      <input
        id={id}
        className="setting-input"
        value={text}
        placeholder={placeholder}
        spellCheck={false}
        list={suggestions ? `${id}-list` : undefined}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setText(initial);
            e.currentTarget.blur();
          }
        }}
      />
      {suggestions && (
        <datalist id={`${id}-list`}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </>
  );
}

/** Per-project commands, kept under the project's entry in `projects`. */
function ProjectTab({ settings, onChange }: { settings: Settings; onChange: () => void }) {
  const state = useAppState();
  const projects = sortedProjects(state);
  const [pid, setPid] = useState(state.selectedProject ?? projects[0]?.id ?? "");
  const project = state.projects[pid];
  if (!project) return <p className="usage-empty">Add a project first.</p>;
  const repo = project.repo_path;
  const commit = async (field: string, v: string) => {
    try {
      await writeProjectSetting(repo, field, v);
      onChange();
    } catch (e) {
      flash(`Couldn't save: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  return (
    <>
      <div className="setting">
        <div className="setting-text">
          <label className="setting-label" htmlFor="set-project">
            Project
          </label>
        </div>
        <select id="set-project" className="setting-input" value={pid} onChange={(e) => setPid(e.target.value)}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <div className="settings-rows">
        <div className="setting">
          <div className="setting-text">
            <label className="setting-label" htmlFor="set-run">
              Run command
            </label>
            <span className="setting-hint">
              What Start runs in a worktree, e.g. npm run dev. Empty uses the checkout's .nebula.json "run".
            </span>
          </div>
          <TextSetting key={`run-${pid}`} id="set-run" value={projectSetting(settings, repo, "run_command")} placeholder=".nebula.json" onCommit={(v) => commit("run_command", v)} />
        </div>
        <div className="setting">
          <div className="setting-text">
            <label className="setting-label" htmlFor="set-open">
              Open command
              <span className="setting-tag">TUI</span>
            </label>
            <span className="setting-hint">
              What the TUI's ⇧O runs to open a worktree, e.g. open http://localhost:3000. Empty uses the checkout's .nebula.json "open".
            </span>
          </div>
          <TextSetting key={`open-${pid}`} id="set-open" value={projectSetting(settings, repo, "open_command")} placeholder=".nebula.json" onCommit={(v) => commit("open_command", v)} />
        </div>
      </div>
    </>
  );
}

const SHORTCUTS: [string, string][] = [
  ["⌘N", "New task in the selected project"],
  ["⌘O", "Add a project"],
  ["⌘P", "Filter projects"],
  ["⌘1 – ⌘9", "Jump to a project"],
  ["⌘J", "Next session waiting on you"],
  ["⌘U", "Claude usage"],
  ["⌘,", "Settings"],
  ["⌘B", "Hide or show the projects sidebar"],
  ["⌥⌘B", "Hide or show the tasks column"],
  ["⇧↵", "Newline in a Claude Code prompt"],
];

function Shortcuts() {
  return (
    <Group title="Desktop app" note="the TUI's hotkeys are edited in the TUI">
      <dl className="shortcuts">
        {SHORTCUTS.map(([k, what]) => (
          <div key={k} className="shortcut">
            <dt>
              <kbd>{k}</kbd>
            </dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
    </Group>
  );
}
