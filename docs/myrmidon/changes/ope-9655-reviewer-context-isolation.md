---

---

## changelog-en

### Reviewer context isolation prototype (OPE-9655)

Add an opt-in Linux launcher with a fresh HOME and workspace, explicit task/diff
handoff and Landlock confinement. A real subprocess canary test verifies that
executor files, symlink aliases and session history cannot be read, including
from children. Production gateway behavior is unchanged.

## changelog-ru

### Reviewer context isolation prototype (OPE-9655)

An opt-in prototype demonstrates filesystem and session-context separation using
explicit review artifacts. It does not enable production reviewer isolation;
network/IPC isolation and gateway integration remain outside this prototype.
