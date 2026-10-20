import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  applyCompanyPrefix,
  extractCompanyPrefixFromPath,
  isBoardPathWithoutPrefix,
  toCompanyRelativePath,
} from "./company-routes";

describe("company routes", () => {
  it("keeps board route roots in sync with the company-prefixed route tree", () => {
    const appSource = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
    const boardRouteRoots = new Set<string>();
    const routeBlock = appSource.match(/function boardRoutes\([\s\S]*?(?=\nfunction )/)?.[0];
    expect(routeBlock).toBeDefined();
    for (const [, root] of routeBlock!.matchAll(/path="([a-z][a-z0-9-]*)/g)) {
      if (!["runs", "budgets"].includes(root!)) boardRouteRoots.add(root!);
    }
    const legacyStart = appSource.indexOf("<Route element={streamlinedUiLoaded", appSource.indexOf("export function App()"));
    const legacyBlock = legacyStart >= 0
      ? appSource.slice(legacyStart).split('<Route path=":companyPrefix"')[0]
      : "";
    for (const [, root] of legacyBlock.matchAll(/path="([a-z][a-z0-9-]*)/g)) {
      boardRouteRoots.add(root!);
    }
    // Team Catalog is mounted by the shared UI surface rather than directly in
    // boardRoutes, so include its route-root declaration in the live tree.
    const teamCatalogSource = readFileSync(fileURLToPath(new URL("../pages/TeamCatalog.tsx", import.meta.url)), "utf8");
    const teamCatalogRoot = teamCatalogSource.match(/const TEAM_CATALOG_ROUTE_ROOT = "\/([a-z][a-z0-9-]*)";/)?.[1];
    expect(teamCatalogRoot).toBeDefined();
    boardRouteRoots.add(teamCatalogRoot!);

    const source = readFileSync(fileURLToPath(new URL("./company-routes.ts", import.meta.url)), "utf8");
    const rootsBlock = source.match(/const BOARD_ROUTE_ROOTS = new Set\(\[([\s\S]*?)\]\);/)?.[1];
    expect(rootsBlock).toBeDefined();
    const listedRoots = new Set([...rootsBlock!.matchAll(/"([a-z][a-z0-9-]*)"/g)].map(([, root]) => root!));

    expect([...listedRoots].filter((root) => !boardRouteRoots.has(root))).toEqual([]);
    expect([...boardRouteRoots].filter((root) => !listedRoots.has(root))).toEqual([]);
  });

  it.each(["swarm-claim", "foraging", "quality", "status", "cases", "pipelines", "stack"])(
    "scopes the Myrmidon %s menu route to the current company",
    (root) => {
      const pathname = `/${root}`;
      const path = `${pathname}?view=all#details`;
      expect(isBoardPathWithoutPrefix(pathname)).toBe(true);
      expect(extractCompanyPrefixFromPath(pathname)).toBeNull();
      expect(applyCompanyPrefix(path, "OPE")).toBe(`/OPE${path}`);
      expect(applyCompanyPrefix(`/OPE${path}`, "OPE")).toBe(`/OPE${path}`);
      expect(toCompanyRelativePath(`/OPE${path}`)).toBe(path);
    },
  );

  it("treats the task-list alias as an unprefixed board route", () => {
    expect(isBoardPathWithoutPrefix("/tasks")).toBe(true);
    expect(extractCompanyPrefixFromPath("/tasks")).toBeNull();
    expect(applyCompanyPrefix("/tasks", "PAP")).toBe("/PAP/tasks");
  });

  it("treats execution workspace paths as board routes that need a company prefix", () => {
    expect(isBoardPathWithoutPrefix("/execution-workspaces/workspace-123")).toBe(true);
    expect(isBoardPathWithoutPrefix("/execution-workspaces/workspace-123/routines")).toBe(true);
    expect(extractCompanyPrefixFromPath("/execution-workspaces/workspace-123")).toBeNull();
    expect(applyCompanyPrefix("/execution-workspaces/workspace-123", "PAP")).toBe(
      "/PAP/execution-workspaces/workspace-123",
    );
    expect(applyCompanyPrefix("/execution-workspaces/workspace-123/routines", "PAP")).toBe(
      "/PAP/execution-workspaces/workspace-123/routines",
    );
  });

  it("normalizes prefixed execution workspace paths back to company-relative paths", () => {
    expect(toCompanyRelativePath("/PAP/execution-workspaces/workspace-123")).toBe(
      "/execution-workspaces/workspace-123",
    );
    expect(toCompanyRelativePath("/PAP/execution-workspaces/workspace-123/routines")).toBe(
      "/execution-workspaces/workspace-123/routines",
    );
  });

  it("treats /search as a board route that needs a company prefix", () => {
    expect(isBoardPathWithoutPrefix("/search")).toBe(true);
    expect(extractCompanyPrefixFromPath("/search")).toBeNull();
    expect(applyCompanyPrefix("/search", "PAP")).toBe("/PAP/search");
    expect(applyCompanyPrefix("/search?q=hello%20world", "PAP")).toBe("/PAP/search?q=hello%20world");
    expect(toCompanyRelativePath("/PAP/search?q=foo")).toBe("/search?q=foo");
  });

  it("rewrites company package paths with the active prefix", () => {
    expect(applyCompanyPrefix("/company/export", "NEU")).toBe("/NEU/company/export");
    expect(applyCompanyPrefix("/company/import", "NEU")).toBe("/NEU/company/import");
    expect(applyCompanyPrefix("/org", "NEU")).toBe("/NEU/org");
  });

  it("does not double-apply the company prefix", () => {
    expect(applyCompanyPrefix("/NEU/company/export", "NEU")).toBe("/NEU/company/export");
  });

  it("normalizes prefixed company export file URLs for parsing", () => {
    expect(toCompanyRelativePath("/NEU/company/export/files/agents/ceo/AGENTS.md")).toBe(
      "/company/export/files/agents/ceo/AGENTS.md",
    );
  });

  // Regression for PAP-10257: Team Catalog navigation (auto-select + row/file
  // clicks) produces company-relative `/teams-catalog/<key>` paths. Without
  // `teams-catalog` in the board-route allowlist, `extractCompanyPrefixFromPath`
  // misread the first segment as a company prefix and `useNavigate` skipped the
  // rewrite, dropping the `/PAP/` prefix and crashing into "Company not found".
  it("re-prefixes team catalog routes so navigate preserves the company prefix", () => {
    expect(isBoardPathWithoutPrefix("/teams")).toBe(false);
    expect(isBoardPathWithoutPrefix("/teams-catalog")).toBe(true);
    expect(isBoardPathWithoutPrefix("/teams-catalog/core-exec-team")).toBe(true);
    expect(extractCompanyPrefixFromPath("/teams-catalog/core-exec-team")).toBeNull();

    // Auto-select effect: `/teams-catalog/<first-key>` must gain the `/PAP/` prefix.
    expect(applyCompanyPrefix("/teams-catalog/core-exec-team", "PAP")).toBe(
      "/PAP/teams-catalog/core-exec-team",
    );
    // File-tree click: nested `/files/<encoded>` path is preserved under the prefix.
    expect(applyCompanyPrefix("/teams-catalog/core-exec-team/files/TEAM.md", "PAP")).toBe(
      "/PAP/teams-catalog/core-exec-team/files/TEAM.md",
    );
    // Already-prefixed paths are left untouched (idempotent — no double prefix).
    expect(applyCompanyPrefix("/PAP/teams-catalog/core-exec-team", "PAP")).toBe(
      "/PAP/teams-catalog/core-exec-team",
    );
    // Round-trips back to a company-relative path.
    expect(toCompanyRelativePath("/PAP/teams-catalog/core-exec-team")).toBe(
      "/teams-catalog/core-exec-team",
    );
  });

  it("treats /artifacts as a board route that needs a company prefix", () => {
    expect(isBoardPathWithoutPrefix("/artifacts")).toBe(true);
    expect(extractCompanyPrefixFromPath("/artifacts")).toBeNull();
    expect(applyCompanyPrefix("/artifacts", "PAP")).toBe("/PAP/artifacts");
    expect(toCompanyRelativePath("/PAP/artifacts")).toBe("/artifacts");
  });

  it("treats /audit as a board route that needs a company prefix", () => {
    expect(isBoardPathWithoutPrefix("/audit")).toBe(true);
    expect(extractCompanyPrefixFromPath("/audit")).toBeNull();
    expect(applyCompanyPrefix("/audit", "PAP")).toBe("/PAP/audit");
    expect(toCompanyRelativePath("/PAP/audit")).toBe("/audit");
  });

  it("treats /tools routes as board routes that need a company prefix", () => {
    expect(isBoardPathWithoutPrefix("/tools")).toBe(true);
    expect(isBoardPathWithoutPrefix("/tools/runtime")).toBe(true);
    expect(extractCompanyPrefixFromPath("/tools")).toBeNull();
    expect(applyCompanyPrefix("/tools", "PAP")).toBe("/PAP/tools");
    expect(applyCompanyPrefix("/tools/runtime", "PAP")).toBe("/PAP/tools/runtime");
    expect(applyCompanyPrefix("/PAP/tools/runtime", "PAP")).toBe("/PAP/tools/runtime");
    expect(toCompanyRelativePath("/PAP/tools/runtime")).toBe("/tools/runtime");
  });

  it("recognizes Decisions without retaining the legacy attention route", () => {
    expect(isBoardPathWithoutPrefix("/decisions")).toBe(true);
    expect(extractCompanyPrefixFromPath("/decisions")).toBeNull();
    expect(applyCompanyPrefix("/decisions", "PAP")).toBe("/PAP/decisions");

    expect(isBoardPathWithoutPrefix("/attention")).toBe(false);
    expect(extractCompanyPrefixFromPath("/attention")).toBe("ATTENTION");
  });

  it("treats /timeline as a board route that needs a company prefix", () => {
    expect(isBoardPathWithoutPrefix("/timeline")).toBe(true);
    expect(extractCompanyPrefixFromPath("/timeline")).toBeNull();
    expect(applyCompanyPrefix("/timeline", "PAP")).toBe("/PAP/timeline");
    expect(toCompanyRelativePath("/PAP/timeline")).toBe("/timeline");
  });

  it("treats Skill Studio create mode as an unprefixed board route", () => {
    expect(isBoardPathWithoutPrefix("/skills/studio/new")).toBe(true);
    expect(extractCompanyPrefixFromPath("/skills/studio/new")).toBeNull();
    expect(applyCompanyPrefix("/skills/studio/new?forkFrom=skill-1", "PAP")).toBe(
      "/PAP/skills/studio/new?forkFrom=skill-1",
    );
    expect(toCompanyRelativePath("/PAP/skills/studio/new?forkFrom=skill-1")).toBe(
      "/skills/studio/new?forkFrom=skill-1",
    );
  });

  it("preserves artifact deep-link anchors when applying the company prefix", () => {
    expect(applyCompanyPrefix("/issues/PAP-10205#work-product-wp-1", "PAP")).toBe(
      "/PAP/issues/PAP-10205#work-product-wp-1",
    );
    expect(applyCompanyPrefix("/issues/PAP-10306#attachment-att-1", "PAP")).toBe(
      "/PAP/issues/PAP-10306#attachment-att-1",
    );
    // Already-prefixed paths are returned untouched.
    expect(applyCompanyPrefix("/PAP/artifacts", "PAP")).toBe("/PAP/artifacts");
  });
});
