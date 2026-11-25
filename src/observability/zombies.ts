import { readFileSync, readdirSync } from "node:fs";

export interface ProcReader {
  pids(): string[];
  stat(pid: string): string | null;
}

const linuxProc: ProcReader = {
  pids: () => {
    try {
      return readdirSync("/proc").filter((d) => /^\d+$/.test(d));
    } catch {
      return [];
    }
  },
  stat: (pid) => {
    try {
      return readFileSync(`/proc/${pid}/stat`, "utf8");
    } catch {
      return null;
    }
  },
};

// /proc/<pid>/stat is "pid (comm) state ppid …"; comm may hold spaces and
// parens, so split after the last ")".
function stateAndParent(stat: string): { state: string; ppid: number } | null {
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const [state, ppid] = stat.slice(close + 2).split(" ");
  const parent = Number(ppid);
  return state && Number.isFinite(parent) ? { state, ppid: parent } : null;
}

/** Zombies waiting on `parentPid` to reap them. Under an init (tini) the server
 * is not PID 1, orphans go to the init, and this stays 0; if the image ever
 * runs the server as PID 1 again, every orphaned Chromium helper lands here. */
export function countZombieChildren(parentPid = process.pid, proc: ProcReader = linuxProc): number {
  let n = 0;
  for (const pid of proc.pids()) {
    const stat = proc.stat(pid);
    if (!stat) continue;
    const parsed = stateAndParent(stat);
    if (parsed?.state === "Z" && parsed.ppid === parentPid) n++;
  }
  return n;
}
