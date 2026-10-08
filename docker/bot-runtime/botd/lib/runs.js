// myrmidon(1.6.5-BOT-DISK-H3f): "is the bot running now" for botd. Directories
// with unsaved git work must not be reaped under a live run (rules.js, runState).
//
// Verdict `live`: true | false | null (null = unknown, treated as live by the rules).
//   true  - a process of this container has its working directory under one of the
//           work roots (/proc/<pid>/cwd), or a run woke the bot (SIGUSR1) within
//           `windowMs`;
//   false - botd has been up for at least `windowMs`, saw no wake-up in that window
//           and the /proc scan worked and found nothing;
//   null  - botd started less than `windowMs` ago (a wake-up before it started is
//           unknowable) or /proc cannot be read.
// The board's "active workspace" is applied in the rules on top of this.

import fs from "node:fs";
import path from "node:path";

export const RUN_WINDOW_MS = 30 * 60 * 1000;

export function createRunProbe({ proc = process, now = Date.now, windowMs = RUN_WINDOW_MS, procRoot = "/proc", roots = ["/workspace", "/scratch"], fsImpl = fs } = {}) {
  const startedAt = now();
  let lastWakeAt = null;
  const onWake = () => {
    lastWakeAt = now();
  };
  if (proc && typeof proc.on === "function") proc.on("SIGUSR1", onWake);

  const under = (cwd) => roots.some((r) => cwd === r || cwd.startsWith(`${r}/`));

  /** Returns true / false, or null when /proc cannot be read. */
  function scanProc() {
    let names;
    try {
      names = fsImpl.readdirSync(procRoot);
    } catch {
      return null;
    }
    let readable = 0;
    for (const n of names) {
      if (!/^\d+$/.test(n) || Number(n) === process.pid) continue;
      let cwd;
      try {
        cwd = fsImpl.readlinkSync(path.join(procRoot, n, "cwd"));
      } catch {
        continue; // exited, or not ours to read
      }
      readable += 1;
      if (under(cwd)) return true;
    }
    return readable > 0 ? false : null;
  }

  function probe() {
    const t = now();
    if (lastWakeAt !== null && t - lastWakeAt < windowMs) return { live: true, why: "wake" };
    const scan = scanProc();
    if (scan === true) return { live: true, why: "process-cwd" };
    if (t - startedAt < windowMs) return { live: null, why: "botd-just-started" };
    if (scan === null) return { live: null, why: "proc-unreadable" };
    return { live: false, why: "idle" };
  }

  return { probe, stop: () => proc && typeof proc.off === "function" && proc.off("SIGUSR1", onWake) };
}
