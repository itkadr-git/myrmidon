import { describe, expect, it } from "vitest";
import {
  appEntryAllowsAgent,
  githubAppsFor,
  githubPatsFor,
  normalizeGitHubAppPermissions,
  type GitHubAppEntry,
  type GitHubSharedIdentitySettings,
} from "../myrmidon/github-shared-identity/settings.js";
import { githubAppTokenPermissionsFor } from "../myrmidon/github-shared-identity/app-token.js";

const workflowRoles = ["engineer", "reviewer", "lead", "release"] as const;
const agentId = "00000000-0000-4000-8000-000000000001";
const otherAgentId = "00000000-0000-4000-8000-000000000002";

function app(roles: string[]): GitHubAppEntry {
  return {
    id: "00000000-0000-4000-8000-000000000003",
    name: "Development workflow",
    appId: "123",
    privateKeySecretId: "00000000-0000-4000-8000-000000000004",
    installationId: null,
    slug: null,
    roles,
    agentIds: [],
    allowedRepos: ["example/board"],
    permissions: normalizeGitHubAppPermissions(undefined),
  };
}

function settings(entry: GitHubAppEntry): GitHubSharedIdentitySettings {
  return { version: 1, enabled: true, apps: [entry], pats: [], commitEmailDomain: null };
}

// Exercise the real selectors without a database, HTTP server, or a
// getEmbeddedPostgresTestSupport() skip gate. These roles are configuration
// values, not a new hard-coded authorization policy or a role hierarchy.
describe("GitHub development workflow role access audit", () => {
  for (const allowedRole of workflowRoles) {
    for (const actualRole of workflowRoles) {
      it(`${allowedRole} entry ${allowedRole === actualRole ? "allows" : "denies"} ${actualRole}`, () => {
        const entry = app([allowedRole]);
        const agent = { id: agentId, role: actualRole };
        const allowed = allowedRole === actualRole;
        expect(appEntryAllowsAgent(entry, agent)).toBe(allowed);
        expect(githubAppsFor(settings(entry), agent, "example/board")).toEqual(allowed ? [entry] : []);
      });
    }
  }

  it.each(["designer", "admin", "Engineer", "engineer-extra", "", null, undefined])(
    "denies unlisted or missing role %s",
    (role) => {
      const entry = app([...workflowRoles]);
      const agent = { id: agentId, role };
      expect(appEntryAllowsAgent(entry, agent)).toBe(false);
      expect(githubAppsFor(settings(entry), agent, "example/board")).toEqual([]);
    },
  );

  it.each(workflowRoles)("does not widen repository scope or permissions for %s", (role) => {
    const entry = app([...workflowRoles]);
    const config = settings(entry);
    const before = JSON.stringify(config);
    const agent = { id: agentId, role };
    expect(githubAppsFor(config, agent, "example/board")).toEqual([entry]);
    for (const repository of ["example/other", "another/board", null]) {
      expect(githubAppsFor(config, agent, repository)).toEqual([]);
    }
    expect(githubAppTokenPermissionsFor(entry.permissions)).toEqual({
      contents: "write",
      pull_requests: "write",
      metadata: "read",
    });
    expect(JSON.stringify(config)).toBe(before);
    expect(githubAppsFor({ ...config, enabled: false }, agent, "example/board")).toEqual([]);
    expect(githubAppsFor(settings({ ...entry, allowedRepos: [] }), agent, "example/board")).toEqual([]);
    expect(githubAppsFor(settings(app([])), agent, "example/board")).toEqual([]);
  });

  it("preserves explicit agent grants without granting other agents or repositories", () => {
    const entry = { ...app([]), agentIds: [agentId] };
    expect(githubAppsFor(settings(entry), { id: agentId, role: "designer" }, "example/board")).toEqual([entry]);
    expect(githubAppsFor(settings(entry), { id: otherAgentId, role: "designer" }, "example/board")).toEqual([]);
    expect(githubAppsFor(settings(entry), { id: agentId, role: "designer" }, "example/other")).toEqual([]);
  });

  it.each(workflowRoles)("does not confer PAT access through the %s role", (role) => {
    const config = settings(app([role]));
    const pat = {
      id: "00000000-0000-4000-8000-000000000005",
      name: "Explicit agent only",
      tokenSecretId: "00000000-0000-4000-8000-000000000006",
      agentIds: [otherAgentId],
      allowedRepos: ["example/board"],
    };
    config.pats = [pat];
    expect(githubPatsFor(config, agentId, "example/board")).toEqual([]);
    expect(githubPatsFor(config, otherAgentId, "example/board")).toEqual([pat]);
    expect(githubPatsFor(config, otherAgentId, "example/other")).toEqual([]);
  });
});
