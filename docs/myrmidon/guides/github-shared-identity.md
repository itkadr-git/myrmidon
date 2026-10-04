# Authorize GitHub once for the whole server with our own GitHub App (GITHUB-SHARED-IDENTITY)

> Russian version: [github-shared-identity.ru.md](github-shared-identity.ru.md)

Development agents push code through the run-scoped GitHub broker
(`POST /runtime-tools/github/credentials`, see CONTAINER-GITHUB-WRITE in
[SETTINGS.md](../SETTINGS.md)). Until now the broker knew only OAuth
identities connected per person or per agent, and those went through the
vendor's cloud connector and the vendor's GitHub App — a third party with
write access to the repositories. This feature replaces that with **our own,
self-hosted GitHub Apps**: register an App once per account or organization,
and every agent the operator allows can push through it. No vendor service
is involved: the board signs the App's JWT and mints the tokens itself.

Several Apps can live side by side — for example the repositories of one
product under its owner's account and the repositories of another product
under a separate bot account. The broker picks the App by the **target
repository of each operation**, so the two never mix.

## How it works

- **Registration.** The operator creates a GitHub App under the account or
  organization that owns the repositories (Settings → Developer settings →
  GitHub Apps → New GitHub App), with only these repository permissions:
  **Contents: Read and write, Pull requests: Read and write, Metadata: Read**.
  No Secrets, no Administration, no Workflows; webhooks off. Then installs it
  on that product's repositories only and generates a private key (PEM).
- **Storage.** The private key goes into a company secret (Settings → Secrets).
  Company settings → **Shared GitHub authorization** lists the Apps: name,
  App id, the key secret (secret picker), the installation id (optional —
  found per repository with `GET /repos/{owner}/{repo}/installation` when
  empty), the agents (roles and/or individual agents) and the allowed
  repositories (`owner/repo` or `owner/<pattern with *>`; the owner is always
  literal). API: `GET`/`PUT /api/myrmidon/companies/:companyId/github-shared-identity`.
  Stored in `instance_settings.general.myrmidonGithubSharedIdentity`; read on
  every broker request — no restart.
- **Issuance.** For an operation on `owner/repo` the broker takes the App
  entries that list the agent and whose patterns match:
  - none → no App identity (`absent`, as before);
  - one → the board signs a 9-minute JWT with the App key and calls
    `POST /app/installations/{id}/access_tokens` with
    `repositories: [repo]` and `permissions: {contents: write,
    pull_requests: write, metadata: read}`. The token works for that one
    repository and nothing else, whatever the App registration allows, and
    expires within an hour (reused from memory until five minutes before
    expiry);
  - two or more → an error (`More than one GitHub App identity matches
    repository …`), no key read, no token. Narrow the patterns so each
    repository belongs to one App.
- **Precedence.** A dedicated (per-agent) OAuth grant, and the run's own
  personal grant, win over an App.
- **Attribution.** Only the authentication is shared. Author and committer
  are the agent: its name and `<agent-slug>@<domain>`, the domain being the
  "Commit email domain" (empty: the reserved placeholder
  `agents.myrmidon.invalid`).
- **Audit.** Every issuance writes the secret store's access event for the
  key read (consumer `workspace-git-credential`, the agent, the run, the
  issue, config path `github_app:<owner/repo>`) and an activity entry
  `myrmidon.github_app.issued` (repository, entry, App id, installation,
  token expiry). Failures: `myrmidon.github_app.denied`. The key, the JWT and
  the token are never logged or persisted; GitHub errors are reduced to the
  HTTP status.

## The vendor cloud connector is off

`MYRMIDON_GITHUB_VENDOR_CONNECTOR` (default unset = **off**): while off, new
managed GitHub connections through the vendor's cloud connector and their
OAuth start are refused, and existing vendor-connector GitHub connections are
ignored by the credential resolver. Set `1` only on an instance that
deliberately uses the vendor service. The settings screen shows the state.

## Operator steps

1. **Per account or organization, register an App** with the three
   permissions above, install it on that product's repositories only, and
   generate a private key.
2. **Store the key** as a company secret (paste the PEM).
3. **Add the App** in Company settings → Shared GitHub authorization: name,
   App id, key secret, optionally the installation id, the repositories
   (`owner-a/*`), the roles (`engineer`) and/or individual agents. Enable
   and save. Repeat for the next product's App.
4. **Check** in an agent's run: `git ls-remote https://github.com/<owner>/<repo>`
   and a push to a scratch branch. The run identity record
   (`run_identity_contexts.github`) shows `available / app / <App name> /
   <owner/repo>`; the activity log shows `myrmidon.github_app.issued`. A
   repository of the other product goes through the other App; a repository
   listed for neither stays `absent`.
5. **Remove the vendor App** from the GitHub account's installed apps if it
   was installed earlier.

## Where the token goes in a bot container

Patch 09 of the bot runtime keeps stripping raw tokens (`GH_TOKEN`,
`GITHUB_TOKEN`, …) from the terminal environment whenever the run carries a
broker capability. The only path to a credential is the image's
`git-credential-paperclip` helper and `gh` wrapper:

- `/etc/gitconfig` sets `useHttpPath = true` for github.com, so git hands the
  helper the repository path; the helper sends `{"repository": "owner/repo"}`
  to the broker and answers git with the issued token for that one
  invocation;
- the `gh` wrapper sends the repository from `-R/--repo`, `GH_REPO`, or the
  `origin` remote of the current directory, and runs the real `gh` with the
  token in that child's environment only.

## Limits

- The GitHub App manifest flow (one-click registration) is not automated
  yet: the App is registered by hand with the permissions listed above.
- The local/SSH launcher of non-container adapters does not name a
  repository yet, so it never receives an App token.
- The App's own MCP tools are not wired: App tokens serve shell git/gh
  through the broker and the server-side workspace git of a run.
