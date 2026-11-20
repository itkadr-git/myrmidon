# Server onboarding: proposed SSH credential lifecycle

[PR #2824](https://github.com/itkadr-git/myrmidon/pull/2824) proposes an SSH worker; it is not merged or deployed. This is not a rollout instruction, and the rest of the executor has separate acceptance gates.

The proposal persists the first accepted host-key fingerprint before authentication and rejects changed fingerprints on reconnect. TOFU does not authenticate the first connection independently. It stores the access private key in the board secret store, verifies a fresh key-only login before optionally disabling password authentication, and retires the bootstrap secret only after a successful verified report when password retention is not requested. Failed cleanup is audited. Each `addServer` attempt owns separate secrets, including when a slug conflict occurs.

The [operator source](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/server-onboard-ssh.md) describes the evidence and limitations; the [affected-tests job](https://github.com/itkadr-git/myrmidon/actions/runs/44820491758/job/136580197745) used loopback SSH and PostgreSQL, not production hosts.
