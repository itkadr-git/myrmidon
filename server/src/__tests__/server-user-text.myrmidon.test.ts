import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// myrmidon(B1b): server-side user-visible string guard. The API error
// responses, onboarding documents, and agent prompts must not present the
// vendor name. Attribution ("Based on Paperclip (MIT)"), external services
// (Paperclip Cloud/Labs/EE/Enterprise), identifiers (PAPERCLIP_* env vars,
// X-Paperclip-* headers, @paperclipai/* packages, paperclipai bin,
// ~/.paperclip paths, paperclip_runner type, MCP server names), and frozen
// legacy snapshots (pre-rename notice bodies, prior Discord command
// definitions) are allowed exceptions.
const FILE = path.join(import.meta.dirname, "server-user-text-scan.txt");

describe("server user-visible text does not name the vendor", () => {
  it("scans the renamed files for stray vendor-name user text", () => {
    // The scan list is produced by this test itself: the files this track
    // renamed are listed in docs/myrmidon/DIVERGENCE.md (B1b row). We scan a
    // stable set of representative high-traffic files rather than the whole
    // tree, so vendor merges do not turn this guard into a merge conflict.
    const root = path.resolve(import.meta.dirname, "../../../src");
    const files = [
      "config-file.ts",
      "index.ts",
      "middleware/private-hostname-guard.ts",
      "adapters/registry.ts",
      "routes/access.ts",
      "routes/agents.ts",
      "routes/environments.ts",
      "routes/execution-workspaces.ts",
      "routes/llms.ts",
      "routes/openapi.ts",
      "routes/org-chart-svg.ts",
      "routes/plugins.ts",
      "routes/project-tools.ts",
      "routes/projects.ts",
      "routes/tool-access.ts",
      "routes/tool-gateway.ts",
      "services/agent-assigned-tools.ts",
      "services/agents.ts",
      "services/built-in-agents.ts",
      "services/company-portability.ts",
      "services/company-skills.ts",
      "services/decision-signing.ts",
      "services/environments.ts",
      "services/execution-workspaces.ts",
      "services/heartbeat.ts",
      "services/photon/adapter.ts",
      "services/plugin-loader.ts",
      "services/remote-http-fetch.ts",
      "services/runner-goals.ts",
      "services/secrets.ts",
      "services/tool-access.ts",
      "services/tool-gateway.ts",
      "services/vercel-connect.ts",
      "services/workspace-runtime.ts",
      "secrets/aws-secrets-manager-provider.ts",
      "secrets/external-stub-providers.ts",
      "services/native-runtime/obsolete-policy-reviews.ts",
      "services/native-runtime/paperclip-runner-tool-authority.ts",
      "services/native-runtime/provider-profile.ts",
      "services/native-runtime/runner-api-client.ts",
      "services/native-runtime/runtime-mode.ts",
    ];
    const allow = [
      // attribution and upstream repo links
      "Based on Paperclip",
      "paperclipai/paperclip",
      // external vendor services
      "Paperclip Cloud",
      "Paperclip Labs",
      "Paperclip EE",
      "Paperclip Enterprise",
      // identifiers: env vars, headers, packages, bin, paths, types
      "PAPERCLIP_",
      "X-Paperclip",
      "@paperclipai",
      "paperclipai",
      "paperclip_runner",
      // MCP server names are session-identity keys, not copy (myrmidon(B1))
      'name: "Paperclip connections"',
      'name: "Paperclip projects"',
      // frozen pre-rename snapshots and legacy literals
      "priorCloseCopyDefinition",
      "preBrandingDefinition",
      "LEGACY_",
      // vendored code and skill paths
      "vendor/paperclip-runner",
      "paperclip-upload-artifact.sh",
      "paperclip issue attachment:download",
      // identity-error class names kept for instanceof compatibility
      "PaperclipRunnerProviderProfileError",
    ];
    const stray: string[] = [];
    for (const rel of files) {
      const full = path.join(root, rel);
      if (!fs.existsSync(full)) continue;
      const text = fs.readFileSync(full, "utf8");
      // strip comments (block and line) so commented identifiers do not trip
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      const re = /Paperclip/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(code)) !== null) {
        const line = code.slice(0, m.index).split("\n").at(-1) + m[0] + code.slice(m.index).split("\n")[0];
        if (allow.some((a) => line.includes(a))) continue;
        stray.push(`${rel}: ${line.trim().slice(0, 160)}`);
      }
    }
    if (stray.length > 0) {
      fs.writeFileSync(FILE, stray.join("\n"), "utf8");
    }
    expect(stray).toEqual([]);
  });
});
