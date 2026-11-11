// myrmidon(OPE-12274 fix): the Codex driver probes the host bwrap for unprivileged user
// namespaces before a session opens. CI hosts deny them, so every driver test against a
// fake app-server was refused with codex_sandbox_unavailable. Tests start with the probe
// passed; the probe tests reset it and probe a fake bwrap themselves.
import { beforeEach } from "vitest";

import { setUserNamespaceProbeForTests } from "./src/drivers/codex/codex-security-config.js";

beforeEach(() => {
  setUserNamespaceProbeForTests(true);
});
