# Authorize GitHub once for the whole server (GITHUB-SHARED-IDENTITY)

> Russian version: [github-shared-identity.ru.md](github-shared-identity.ru.md)

Development agents push code through the run-scoped GitHub broker
(`POST /runtime-tools/github/credentials`, see CONTAINER-GITHUB-WRITE in
[SETTINGS.md](../SETTINGS.md)). Until now the broker knew only OAuth
identities connected **per person** or **per agent**: every agent needed its
own GitHub authorization, or a run worked only when its responsible person had
connected their own account. A shared GitHub authorization removes that: one
OAuth pass for the whole server, used by every agent the operator allows.

Several shared authorizations can live side by side — for example the
repositories of one product under one GitHub account and the repositories of
another product under a separate bot account. The broker picks the identity
by the **target repository of each operation**, so the two never mix.

## What it is

- **The connection.** An ordinary managed GitHub connection (Apps → GitHub)
  whose identity is **"Shared company GitHub account"**: credential policy
  `shared`, exactly one `organization` grant, created by one OAuth pass in
  which the GitHub App is installed on the chosen repositories. Install it
  for the company ("Any agent") or for chosen agents.
- **The access rules.** Company settings → **Shared GitHub authorization**
  (`GET`/`PUT /api/myrmidon/companies/:companyId/github-shared-identity`):
  a master switch and, per shared connection, the agents that may use it
  (roles and/or individual agents) and the repositories it serves
  (`owner/repo` or `owner/<pattern with *>`; the owner is always literal).
  Stored in `instance_settings.general.myrmidonGithubSharedIdentity`; read on
  every broker request, so a change applies to the next git/gh operation —
  no restart.
- **Precedence.** A dedicated (per-agent) grant wins over a shared grant; so
  does the run's own personal grant. A shared grant is the last resort.
- **Selection by repository.** For each operation the broker takes the
  connections whose rule lists the agent **and** whose patterns match the
  target repository:
  - none → the shared identities are absent for this operation (as before:
    `absent`, the server-side workspace git keeps its legacy fallback);
  - one → that identity is issued;
  - two or more with different GitHub accounts → an error
    (`More than one shared GitHub identity matches repository …`), never a
    silent pick. Narrow the patterns so each repository belongs to one
    connection.
- **Issuance.** Right before the token is read the broker re-checks the rule
  and requires the repository to be part of the GitHub App installation of
  that grant (when the grant records the list). A refusal is journaled
  (`myrmidon.github_shared.denied`) and answered `unavailable`.
- **Attribution.** Only the authentication is shared. Author and committer
  are the agent: its name and `<agent-slug>@<domain>`, where the domain is
  the "Commit email domain" of the rules (empty: the reserved placeholder
  `agents.myrmidon.invalid`).
- **Audit.** Every issuance writes the secret store's access event
  (consumer `workspace-git-credential`, the agent, the run, the issue,
  config path `github_shared:<owner/repo>`) and an activity entry
  `myrmidon.github_shared.issued` (agent, run, repository, connection,
  grant). The token is never logged, persisted in the run identity or
  returned anywhere but the credential response itself.

## Operator steps

1. **Decide the accounts.** One GitHub account per product (or one for all).
   Prefer a machine account with write access only to its product's
   repositories.
2. **Authorize once per account.** Apps → GitHub → identity **"Shared company
   GitHub account (advanced)"** (needs the connection-manager permission) →
   choose "Any agent" → sign in to GitHub as that account and install the
   GitHub App on that product's repositories only. Repeat for the next
   account.
3. **Write the rules.** Company settings → Shared GitHub authorization →
   enable, and for each connection: tick "Allow agents to use this
   connection", list the repositories (`owner-a/*`), the roles (`engineer`)
   and/or tick individual agents. Optionally set the commit email domain.
   Save.
4. **Check.** In an agent's run: `git ls-remote https://github.com/<owner>/<repo>`
   and a push to a scratch branch. The run's identity record
   (`run_identity_contexts.github`) shows `available / shared / <login> /
   <owner/repo>`; the activity log shows `myrmidon.github_shared.issued`.
   A repository of the other product resolves to the other login; a
   repository listed for neither stays `absent`.

## Where the token goes in a bot container

The bot runtime patch 09 keeps stripping raw tokens (`GH_TOKEN`,
`GITHUB_TOKEN`, …) from the terminal environment whenever the run carries a
broker capability. The only path to a credential is the image's
`git-credential-paperclip` helper and `gh` wrapper:

- `/etc/gitconfig` sets `useHttpPath = true` for github.com, so git hands the
  helper the repository path; the helper sends `{"repository": "owner/repo"}`
  to the broker and answers git with the issued credential for that one
  invocation;
- the `gh` wrapper sends the repository from `-R/--repo`, `GH_REPO`, or the
  `origin` remote of the current directory, and runs the real `gh` with the
  issued token in that child's environment only.

A shared grant is never issued without a repository, and never to the board's
MCP tool list (the GitHub MCP connection filter and the server's non-run
workspace git do not consider shared grants).

## Limits

- The token issued is the shared grant's OAuth user-to-server token (it
  expires and is refreshed by the board). GitHub cannot narrow such a token
  to one repository: the per-repository decision is the broker's, and the
  hard technical boundary is the set of repositories chosen when the GitHub
  App was installed in step 2. Install each account's App only on its own
  product's repositories.
- Repository-scoped installation tokens would need the GitHub App's private
  key on this server; the managed connector's App is operated outside the
  server, so that is not part of this change.
- The local/SSH launcher of non-container adapters does not name a
  repository yet, so it never receives a shared grant.
