// myrmidon(ROLE-SCOPED-TOKENS): enforce board API key scopes for admin actions.
// A board key with a stored scope may only perform the admin actions that its
// scope allows; requests outside the scope are rejected with 403 before the
// route runs. Keys without a stored scope (created before this change, or
// explicitly "full") keep unrestricted board access, so existing operator and
// CLI flows are unaffected.
import type { Request, Response, NextFunction } from "express";
import type { BoardApiKeyScope } from "@paperclipai/shared";
import { isMonitoringLinkScope } from "@paperclipai/shared";
import { forbidden } from "../errors.js";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Route prefixes whose mutations are permitted per scope kind. Prefixes are
// matched against the path below /api. A mutating route not listed here is
// denied for every non-full scope (default-deny).
const MUTATION_ALLOWLIST: Record<
  Exclude<BoardApiKeyScope["kind"], "full" | "read_only" | "monitoring_link">,
  string[]
> = {
  ops: [
    "/health",
    "/chat-endpoints",
    "/chat-identity-links",
    "/tool-connections",
    "/tool-gateway",
    "/tool-profiles",
    "/tool-profile-entries",
    "/tool-applications",
    "/secret-provider-configs",
  ],
  agents_manage: [
    "/agents",
    "/join-requests",
    "/chat-endpoints",
  ],
  secrets_manage: [
    "/secrets",
    "/secret-provider-configs",
  ],
  release: [
    "/health",
    "/issues",
    "/work-products",
    "/attachments",
    "/execution-workspaces",
  ],
};

// Company-scoped mutation paths under /companies/:id/... that belong to a
// scope's domain (e.g. POST /companies/:id/secrets for secrets_manage).
const COMPANY_NESTED_MUTATIONS: Record<
  Exclude<BoardApiKeyScope["kind"], "full" | "read_only" | "monitoring_link">,
  string[]
> = {
  ops: ["/tool-connections", "/tool-gateway", "/chat-endpoints"],
  agents_manage: ["/agents", "/join-requests", "/chat-endpoints"],
  secrets_manage: ["/secrets", "/secret-provider-configs"],
  release: ["/issues", "/work-products", "/attachments"],
};

// myrmidon(1.6.6 MONITORING E): a linking component's key is method-aware,
// because "create a task" and "update a task" are different verbs on different
// routes in this API (POST /companies/:id/issues, PATCH /issues/:id). The pair
// of lists below is the whole surface such a key ever gets: create a task,
// update a task, report its own liveness, and read the few things a link needs
// to do its job (its liveness view, the heartbeat endpoint, the issue it
// touched). Everything else — closing tasks, agents, secrets, plugins — is
// denied, so a stolen link key cannot do operator work.
const MONITORING_LINK_MUTATIONS: Array<{
  method: string;
  matches: (pathBelowApi: string) => boolean;
}> = [
  { method: "POST", matches: (p) => /^\/companies\/[^/]+\/issues$/.test(p) },
  { method: "PATCH", matches: (p) => /^\/issues\/[^/]+$/.test(p) },
  {
    method: "POST",
    matches: (p) => /^\/myrmidon\/companies\/[^/]+\/monitoring\/links\/pulse$/.test(p),
  },
];

const MONITORING_LINK_READS: Array<(pathBelowApi: string) => boolean> = [
  (p) => p === "/health",
  (p) => /^\/companies\/[^/]+\/issues(\?.*)?$/.test(p),
  (p) => /^\/issues\/[^/]+(\?.*)?$/.test(p),
  (p) => /^\/myrmidon\/companies\/[^/]+\/monitoring\/links(\?.*)?$/.test(p),
];

function monitoringLinkAllows(method: string, pathBelowApi: string): boolean {
  const upper = method.toUpperCase();
  if (READ_METHODS.has(upper)) {
    // HEAD/OPTIONS stay open: they carry no body and are used by clients for
    // preflight, the same way every other scope treats them.
    if (upper !== "GET") return true;
    return MONITORING_LINK_READS.some((matches) => matches(pathBelowApi));
  }
  return MONITORING_LINK_MUTATIONS.some(
    (entry) => entry.method === upper && entry.matches(pathBelowApi),
  );
}

function matchPrefix(pathBelowApi: string, prefix: string) {
  return (
    pathBelowApi === prefix ||
    pathBelowApi.startsWith(prefix + "/") ||
    pathBelowApi.startsWith(prefix + "?")
  );
}

function companyNestedMatch(pathBelowApi: string, nested: string) {
  const m = /^\/companies\/[^/]+(\/.*)$/.exec(pathBelowApi);
  if (!m) return false;
  const rest = m[1];
  return rest === nested || rest.startsWith(nested + "/");
}

export function boardApiKeyScopeAllows(
  scope: BoardApiKeyScope | null | undefined,
  method: string,
  pathBelowApi: string,
): boolean {
  if (!scope || scope.kind === "full") return true;
  if (scope.kind === "monitoring_link") {
    // Defense in depth: the actor's scope is normalized where the key is
    // authenticated, but this is the enforcement point. A link scope that lost
    // the policy fields it cannot work without (a hand-edited or truncated
    // row) is not usable and degrades to read-only.
    if (!isMonitoringLinkScope(scope)) return READ_METHODS.has(method.toUpperCase());
    return monitoringLinkAllows(method, pathBelowApi);
  }
  if (READ_METHODS.has(method.toUpperCase())) return true;
  if (scope.kind === "read_only") return false;
  const prefixes = MUTATION_ALLOWLIST[scope.kind] ?? [];
  if (prefixes.some((p) => matchPrefix(pathBelowApi, p))) return true;
  const nested = COMPANY_NESTED_MUTATIONS[scope.kind] ?? [];
  if (nested.some((n) => companyNestedMatch(pathBelowApi, n))) return true;
  return false;
}

export function boardKeyScopeMiddleware() {
  return (req: Request, _res: Response, next: NextFunction) => {
    // myrmidon(ROLE-SCOPED-TOKENS): only board-key actors carry a key scope;
    // session/local/cloud board actors are operator context, not role keys.
    if (req.actor?.type !== "board" || req.actor?.source !== "board_key") {
      next();
      return;
    }
    const scope = req.actor.boardKeyScope;
    if (!scope || scope.kind === "full") {
      next();
      return;
    }
    // myrmidon(ROLE-SCOPED-TOKENS): the middleware is mounted at the app root
    // (app.ts), so req.path starts with /api. Strip only the /api prefix and
    // keep the leading slash of the route below it: the allowlist entries all
    // start with "/". A bare "/api" (empty remainder) maps to "/".
    const pathBelowApi = req.path.replace(/^\/api(?=\/|$)/, "") || "/";
    if (boardApiKeyScopeAllows(scope, req.method, pathBelowApi)) {
      next();
      return;
    }
    next(
      forbidden(`Board API key scope '${scope.kind}' does not allow this action`, {
        scope: scope.kind,
        method: req.method,
        path: req.path,
      }),
    );
  };
}
