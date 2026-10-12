// docker/bot-runtime/build-wrappers/heavy-fallback.js
//
// myrmidon(1.6.5 DEVBUILD-IN-BOTS): a heavy build command can still reach
// the real binary with the devbuild gateway present (a build container —
// the gate's whole point) or through a direct binary path in the ordinary
// bot container (node_modules/.bin/tsc, /opt/pnpm/bin/pnpm — the wrappers
// only cover the bare names on PATH). In BOTH cases the process then runs
// inside this container's cgroup, and an uncapped V8 heap is what produced
// the vm-core OOM kills (tsc ~3.5 GB against a ~3 GB container budget).
//
// Every wrapper's pass-through goes through applyHeavyFallback(): it caps
// the Node.js old-space heap of the child at a container-safe ceiling
// (default 2048 MB, override MYRMIDON_LOCAL_NODE_HEAP_MB, 0 disables) and
// prints one stderr warning naming the devbuild replacement — loud, not
// blocking. A caller's own NODE_OPTIONS is kept; the cap is appended after
// it, so an explicit --max-old-space-size from the caller wins (the last
// occurrence is the one Node honours).
//
// CJS on purpose (see devbuild-gate.js): in the image this file lives at
// /opt/paperclip/bin/, which no package.json reaches.

"use strict";

const DEFAULT_LOCAL_NODE_HEAP_MB = 2048;

function localNodeHeapMb(env = process.env) {
  const raw = (env.MYRMIDON_LOCAL_NODE_HEAP_MB || "").trim();
  if (raw === "") return DEFAULT_LOCAL_NODE_HEAP_MB;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_LOCAL_NODE_HEAP_MB;
  return n; // 0 = opt out (the operator's deliberate choice)
}

// Returns the env the heavy child should get: the caller's env plus the
// heap cap, unless the cap is disabled or the caller already capped the
// heap themselves.
function heavyChildEnv(tool, env = process.env) {
  const mb = localNodeHeapMb(env);
  if (mb === 0) return { env, warning: null };
  const existing = env.NODE_OPTIONS || "";
  if (/--max-old-space-size/.test(existing)) return { env, warning: null };
  return {
    env: { ...env, NODE_OPTIONS: `${existing} --max-old-space-size=${mb}`.trim() },
    warning: [
      `${tool}: running a heavy build command inside the bot container — heap capped at ${mb} MB (MYRMIDON_LOCAL_NODE_HEAP_MB).`,
      `Prefer the build VPS: devbuild ${tool} ...  (0 local tsc/vitest runs is the fleet target; the cap is a fallback, not the path.)`,
    ].join("\n"),
  };
}

// applyHeavyFallback(tool): returns { env, warning }; the caller spawns the
// real binary with env and writes the warning to stderr first.
function applyHeavyFallback(tool, env = process.env) {
  return heavyChildEnv(tool, env);
}

module.exports = { applyHeavyFallback, localNodeHeapMb, DEFAULT_LOCAL_NODE_HEAP_MB };
