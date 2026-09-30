import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isPreview } from "./client";
import { getState, setState } from "./store";

export * from "./usageData";
import type { UsageReport } from "./usageData";

// ---- loading ----

const DAYS = 30;
let loading = false;
/** Asked for mid-scan (a Refresh click): scan again once this one lands. */
let again = false;

export async function refreshUsage() {
  if (loading) {
    again = true;
    return;
  }
  loading = true;
  try {
    const report = isPreview()
      ? (await import("./mock")).mockUsage()
      : await invoke<UsageReport>("usage_report", { days: DAYS });
    setState({ usage: report, usageError: null });
  } catch (e) {
    setState({ usageError: String(e) });
  } finally {
    loading = false;
  }
  if (again) {
    again = false;
    void refreshUsage();
  }
}

/** Mount once: keeps `state.usage` fresh — every minute while the usage view
 *  is open, every five otherwise (the sidebar shows today's usage). */
export function useUsagePolling() {
  useEffect(() => {
    void refreshUsage();
    let last = Date.now();
    const t = setInterval(() => {
      if (document.hidden) return;
      const every = getState().view === "usage" ? 60_000 : 300_000;
      if (Date.now() - last >= every) {
        last = Date.now();
        void refreshUsage();
      }
    }, 15_000);
    return () => clearInterval(t);
  }, []);
}
