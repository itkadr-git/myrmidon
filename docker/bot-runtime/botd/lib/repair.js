// botd runs myr-ws repair only when no run is active or potentially active.
// The repair preserves unfinished Git operations. A failure never breaks the pass.

/**
 * @param {{ ws: (args: string[]) => Promise<any>, runProbe: { probe: () => { live: boolean | null } }, log: (line: string) => void }} deps
 * @returns {Promise<{ ran: boolean, repaired: number }>}
 */
export async function repairInterrupted({ ws, runProbe, log }) {
  let verdict;
  try {
    verdict = runProbe.probe();
  } catch {
    return { ran: false, repaired: 0 };
  }
  if (!verdict || verdict.live !== false) return { ran: false, repaired: 0 };
  let res;
  try {
    res = await ws(["repair"]);
  } catch (err) {
    log(`botd: myr-ws repair failed: ${String((err && err.message) || err).slice(0, 200)}`);
    return { ran: true, repaired: 0 };
  }
  const repaired = Array.isArray(res.repaired) ? res.repaired : [];
  for (const r of repaired) {
    const what = (r.recovered || []).map((x) => `${x.problem}:${x.action}`).join(",");
    log(`botd: repaired interrupted copy ${r.key} (${what})${r.recoveryRef ? `, state in ${r.recoveryRef}` : ""}`);
  }
  for (const e of Array.isArray(res.errors) ? res.errors : []) log(`botd: repair of ${e.key} failed: ${String(e.error).slice(0, 200)}`);
  return { ran: true, repaired: repaired.length };
}
