// server/src/myrmidon/github-shared-identity/broker.ts
//
// myrmidon(GITHUB-SHARED-IDENTITY): the broker-side seam. The run-scoped
// GitHub broker (github-operation-credentials.ts) calls this when no
// dedicated, personal or delegated OAuth grant exists for the run. It maps
// the GitHub App resolution onto the broker's summary and env:
//
//   issued         -> available, source "app", the App entry name, repository;
//                     env carries the installation token
//   ambiguous      -> unavailable (two Apps match the repository: never a silent pick)
//   error          -> unavailable (fail closed: no legacy fallback)
//   not_applicable -> null (the broker keeps its own answer)
//
// The summary is persisted into run_identity_contexts.github and returned to
// the caller; it never contains the token. The env goes to the caller only.

import type { Db } from "@paperclipai/db";
import { buildGitAuthInvocation } from "../../services/git-credentials.js";
import type { GitHubCredentialSummary } from "../../services/github-operation-credentials.js";
import { secretService } from "../../services/secrets.js";
import { resolveGitHubAppCredential } from "./resolve.js";

export async function applyGitHubAppIdentity(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    runId: string;
    issueId: string | null;
    responsibleUserId: string | null;
    repository: string | null;
  },
): Promise<{ summary: GitHubCredentialSummary; env: Record<string, string> } | null> {
  const secrets = secretService(db);
  const resolution = await resolveGitHubAppCredential(
    db,
    { resolveSecretValue: (companyId, secretId, version, options) => secrets.resolveSecretValue(companyId, secretId, version, options) },
    input,
  );
  switch (resolution.kind) {
    case "not_applicable":
      return null;
    case "ambiguous":
      return {
        summary: {
          status: "unavailable",
          source: "app",
          repository: resolution.repository,
          reason: `More than one GitHub App identity matches repository ${resolution.repository} (${resolution.entries.join(", ")}); narrow the allowed repositories`,
        },
        env: {},
      };
    case "error":
      return {
        summary: {
          status: "unavailable",
          source: "app",
          login: resolution.name,
          repository: resolution.repository,
          reason: resolution.reason,
        },
        env: {},
      };
    case "issued":
      return {
        summary: {
          status: "available",
          source: "app",
          login: resolution.name,
          repository: resolution.repository,
          authenticationMode: "managed",
        },
        env: buildGitAuthInvocation(resolution.credential).env,
      };
  }
}
