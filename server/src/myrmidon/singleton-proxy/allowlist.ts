// server/src/myrmidon/singleton-proxy/allowlist.ts
//
// myrmidon(1.6.6 PROCS-1.5 / OPE-5412, design OPE-5394 §0.6 and §7.1): the
// allowlist of "single" routes — the ones whose state lives in ONE process (the
// worker): the attention feed (in-memory signals of seven sources), the plugin
// host (plugin workers are forked by the worker only), the bot-container
// control (the docker driver is the worker's alone) and the workspace-runtime
// control (service registries are process-local). An api process of a split
// board forwards exactly these paths to the worker; everything else it serves
// itself. Pure data and predicates — no I/O.

export type SingletonRouteGroup = "attention" | "plugins" | "bot_container" | "workspace_runtime";

/** Every group, in exposition order (the metric renders all of them, zeros included). */
export const SINGLETON_ROUTE_GROUPS: readonly SingletonRouteGroup[] = [
  "attention",
  "plugins",
  "bot_container",
  "workspace_runtime",
];

type SingletonRoute = {
  group: SingletonRouteGroup;
  /** HTTP methods forwarded; `null` = every method. */
  methods: readonly string[] | null;
  /** Matched against the path below `/api`, without the query string. */
  pattern: RegExp;
};

const SEGMENT = "[^/]+";

export const SINGLETON_ROUTES: readonly SingletonRoute[] = [
  { group: "attention", methods: ["GET"], pattern: new RegExp(`^/companies/${SEGMENT}/attention/?$`) },
  { group: "plugins", methods: null, pattern: /^\/plugins(?:\/.*)?$/ },
  {
    group: "bot_container",
    methods: null,
    pattern: new RegExp(`^/myrmidon/agents/${SEGMENT}/bot-container(?:/.*)?$`),
  },
  {
    group: "workspace_runtime",
    methods: ["POST"],
    pattern: new RegExp(`^/projects/${SEGMENT}/workspaces/${SEGMENT}/runtime-(?:services|commands)/${SEGMENT}/?$`),
  },
  {
    group: "workspace_runtime",
    methods: ["POST"],
    pattern: new RegExp(`^/execution-workspaces/${SEGMENT}/runtime-(?:services|commands)/${SEGMENT}/?$`),
  },
];

/** The group of a single route, or null when this request is the api's own. */
export function singletonRouteGroup(method: string, pathBelowApi: string): SingletonRouteGroup | null {
  const upper = method.toUpperCase();
  for (const route of SINGLETON_ROUTES) {
    if (route.methods && !route.methods.includes(upper)) continue;
    if (route.pattern.test(pathBelowApi)) return route.group;
  }
  return null;
}
