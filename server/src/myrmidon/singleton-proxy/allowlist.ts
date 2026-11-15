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
//
// myrmidon(OPE-12032): the bot-container group also holds the remote-site
// fleet control (restart/stop/logs/move of a bot on a site, the site screen's
// per-site reads and drain/resume). The mTLS client manager of the sites and
// the bot-container runtime are built by `startBotContainers`, which only the
// worker runs; an api process has neither, so it answered "site has no active
// mTLS client transport" for a site that is registered and healthy.

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
  // Fleet control of bots on remote sites (fleet-site-manage-routes.ts, fleet-move-routes.ts):
  // `/myrmidon/fleet/bots/:key/(restart|stop|logs)`, `/myrmidon/fleet/sites/overview`,
  // `/myrmidon/fleet/sites/:name[/bots|/drain|/resume]`, `/fleet/bots/:key/(move|logs)`.
  // Not `/myrmidon/fleet/sites` itself (registry list, database only), `/myrmidon/fleet/servers`
  // and the console routes, nor `/companies/:id/fleet/sites` (enroll/list/delete: database only).
  {
    group: "bot_container",
    methods: null,
    pattern: new RegExp(`^/myrmidon/fleet/bots/${SEGMENT}(?:/.*)?$`),
  },
  {
    group: "bot_container",
    methods: null,
    pattern: new RegExp(`^/myrmidon/fleet/sites/${SEGMENT}(?:/.*)?$`),
  },
  {
    group: "bot_container",
    methods: null,
    pattern: new RegExp(`^(?:/api/myrmidon)?/fleet/bots/${SEGMENT}(?:/.*)?$`),
  },
  // myrmidon(OPE-12957): the stack registry probes (images through dockergate) run in
  // `collectStackLocal`, and dockergate admits only the board's main process. An api
  // process got `write EPIPE` and answered 503 "stack refresh failed". Not
  // `GET /myrmidon/stack`: it reads the saved document from the database.
  { group: "bot_container", methods: ["POST"], pattern: /^\/myrmidon\/stack\/(?:refresh|check)\/?$/ },
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
