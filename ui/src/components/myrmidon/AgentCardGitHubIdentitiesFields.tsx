// myrmidon(GITHUB-IDENTITIES-C): the "GitHub identities" section of a bot's card.
//
// A bot may act as several GitHub accounts, each scoped to the owner of the
// repositories it is allowed to push to: `adapterConfig.githubIdentities =
// [{ owner, login?, secretName }]`. Inside the container, git and gh pick the
// account by the repository URL, so a push outside these owners is impossible
// rather than merely discouraged. This section is READ-ONLY: the list is written
// through the API and the secrets it names, and the server owns the card's token
// bindings — a form that could edit it would be a second, unchecked writer.

import { useState } from "react";
import { CollapsibleSection } from "../agent-config-primitives";

/** One account as the section shows it. */
export interface GitHubIdentityView {
  /** Repository owner the account is scoped to; the scope reads `<owner>/*`. */
  owner: string;
  /** The login the token belongs to, when the card names it. */
  login: string | null;
  /** Company secret the container resolves the token from. */
  secretName: string;
}

export interface GitHubIdentitiesRead {
  identities: GitHubIdentityView[];
  /** Entries that cannot be shown as they are; one line each. */
  problems: string[];
}

function readText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * `adapterConfig.githubIdentities` as the section reads it. A missing or empty list
 * is an empty section, not a problem. An entry that names no owner or no secret is
 * dropped and reported instead of being shown half-read: the scope or the secret it
 * would show is simply not there, and a blank cell reads as "no scope" when the
 * truth is "the card is wrong". Two entries claiming one owner are reported too —
 * the container can resolve only one account per owner.
 */
export function readGitHubIdentities(value: unknown): GitHubIdentitiesRead {
  if (value === undefined || value === null) return { identities: [], problems: [] };
  if (!Array.isArray(value)) {
    return { identities: [], problems: ["The card's GitHub identities are not a list."] };
  }
  const identities: GitHubIdentityView[] = [];
  const problems: string[] = [];
  value.forEach((entry, index) => {
    const position = index + 1;
    const record =
      entry !== null && typeof entry === "object" && !Array.isArray(entry)
        ? (entry as Record<string, unknown>)
        : null;
    if (record === null) {
      problems.push(`Entry ${position} is not an object.`);
      return;
    }
    const owner = readText(record.owner);
    const secretName = readText(record.secretName);
    if (!owner || !secretName) {
      const missing = [!owner && "owner", !secretName && "secretName"].filter(Boolean).join(" and ");
      problems.push(`Entry ${position} is incomplete: ${missing} missing.`);
      return;
    }
    identities.push({ owner, login: readText(record.login), secretName });
  });
  const seen = new Set<string>();
  for (const identity of identities) {
    if (seen.has(identity.owner)) {
      problems.push(`Two entries claim the same owner: ${identity.owner}/*.`);
    }
    seen.add(identity.owner);
  }
  return { identities, problems };
}
/**
 * The section's body. It takes the field as it is on the card (edited or saved —
 * the list is not edited here, so both readings render the same) and holds no
 * inputs: the only control is the section header that opens and closes it.
 */
export function AgentCardGitHubIdentitiesFieldsView({ value }: { value: unknown }) {
  const { identities, problems } = readGitHubIdentities(value);
  const [open, setOpen] = useState(true);

  return (
    <CollapsibleSection title="GitHub identities" open={open} onToggle={() => setOpen((current) => !current)}>
      <div className="space-y-3" data-testid="myrmidon-agent-github-identities">
        <p className="text-xs text-muted-foreground">
          The GitHub accounts this bot may act as, one per repository owner. Inside the container, git and gh pick the
          account by the repository URL, so a push outside these owners is impossible. The list is not edited here: it
          is written through the API and the secrets it names.
        </p>

        {identities.length === 0 && problems.length === 0 && (
          <p className="text-xs text-muted-foreground" data-testid="myrmidon-agent-github-identities-empty">
            No GitHub identities on this card: the bot uses the single GitHub token from its card environment.
          </p>
        )}

        {identities.length > 0 && (
          <ul className="space-y-1.5" data-testid="myrmidon-agent-github-identities-list">
            {identities.map((identity, index) => (
              <li
                key={`${index}:${identity.owner}`}
                className="rounded-md border border-border px-2.5 py-2"
                data-testid="myrmidon-agent-github-identity"
              >
                <div className="font-mono text-sm" data-testid="myrmidon-agent-github-identity-owner">
                  {identity.owner}/*
                </div>
                <div className="text-xs text-muted-foreground" data-testid="myrmidon-agent-github-identity-login">
                  Login: {identity.login ?? "not reported"}
                </div>
                <div className="text-xs text-muted-foreground" data-testid="myrmidon-agent-github-identity-secret">
                  Secret: {identity.secretName}
                </div>
              </li>
            ))}
          </ul>
        )}

        {problems.length > 0 && (
          <ul className="space-y-0.5 text-xs text-amber-400" data-testid="myrmidon-agent-github-identities-problems">
            {problems.map((problem, index) => (
              <li key={`${index}:${problem}`} data-testid="myrmidon-agent-github-identity-problem">
                {problem}
              </li>
            ))}
          </ul>
        )}
      </div>
    </CollapsibleSection>
  );
}

/**
 * The section as the card mounts it: `adapterConfig.githubIdentities` of the agent
 * being edited. The list lives on the card itself, so there is nothing to load and
 * nothing to save — the view is the whole section.
 */
export function AgentCardGitHubIdentitiesFields({ value }: { value: unknown }) {
  return <AgentCardGitHubIdentitiesFieldsView value={value} />;
}
