# Server onboarding: proposed SSH credential lifecycle

This describes the proposal in [PR #2824](https://github.com/itkadr-git/myrmidon/pull/2824), not a released or deployed capability. The PR is open and the rest of the fleet executor remains subject to its own acceptance gates. Do not use this description as a deployment instruction.

## Host identity and access

The proposed worker uses trust on first use (TOFU): it persists the first accepted SSH host-key fingerprint before authentication and rejects a changed fingerprint before sending credentials, including on reconnect. TOFU does not independently authenticate the first connection; verify the initial host identity through a trusted channel when required.

The access private key is held in the board secret store. The worker installs its matching public key and verifies a fresh key-only SSH connection before optionally disabling password authentication. If password retention is not requested, the board deletes the bootstrap password only after a successful terminal report attesting to that fresh login and matching the current pin and stored key. A cleanup failure is audited; deletion is not guaranteed. Duplicate or concurrent `addServer` attempts use attempt-specific secrets, so a losing slug conflict cannot rotate or remove the registered server's secrets.

## Evidence and status

The [affected-tests job](https://github.com/itkadr-git/myrmidon/actions/runs/44820491758/job/136580197745) passed on PR head `61d7f5f345920c28a09ecc1c8da0687829cfd273`. Its credential lifecycle test uses loopback SSH and embedded PostgreSQL; remote command effects are simulated, not run on production hosts. Passing tests do not establish deployment or acceptance of the entire executor. Before the proposal is merged and deployed, no production rollback of this change is needed.
