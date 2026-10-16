#!/usr/bin/env python3
"""Behaviour regression for 17-disabled-tools-by-name.patch (measure D of the input-token economy).

`agent.disabled_tools` in config.yaml removes single tools from the schema the model gets, after the
toolset selection (a toolset cannot split the browser credential vault from the browser, nor
vision_analyze from anything else). Unset or empty, the selection is exactly what it was.

    python3 tests/disabled_tools.py [hermes-checkout-dir]
"""

import os
import sys
import tempfile
from pathlib import Path


def _hermes_dir(argv):
    for candidate in (argv[1] if len(argv) > 1 else None, os.getcwd(), "/opt/hermes-src"):
        if candidate and Path(candidate, "hermes_state.py").is_file():
            return Path(candidate)
    sys.exit("cannot find a hermes checkout (pass its directory as the first argument)")


def main(argv):
    hermes_dir = _hermes_dir(argv)
    home = Path(tempfile.mkdtemp(prefix="disabled-tools-"))
    os.environ["HERMES_HOME"] = str(home)
    sys.path.insert(0, str(hermes_dir))
    import model_tools

    failures = []

    def check(name, cond):
        if not cond:
            failures.append(name)
            print("FAIL:", name)

    def names():
        model_tools._clear_tool_defs_cache()
        return {d["function"]["name"] for d in model_tools.get_tool_definitions(
            enabled_toolsets=["file", "terminal", "skills", "browser", "vision"], quiet_mode=True)}

    baseline = names()
    selected = model_tools._select_tool_names(["file", "terminal", "vision"], None, True)
    check("baseline: vision_analyze is selectable", "vision_analyze" in selected)
    check("baseline: read_file present", "read_file" in baseline)

    (home / "config.yaml").write_text("agent:\n  disabled_tools:\n    - vision_analyze\n    - browser_vault_list\n")
    after = model_tools._select_tool_names(["file", "terminal", "vision"], None, True)
    check("listed tools leave the selection", "vision_analyze" not in after)
    check("other tools of the toolset stay", {"read_file", "terminal"} <= after)
    check("the schema follows the config", "vision_analyze" not in names())
    check("nothing else is removed from the schema", names() == baseline - {"vision_analyze", "browser_vault_list"})

    (home / "config.yaml").write_text("agent:\n  disabled_tools: vision_analyze\n")
    check("a bare name is one entry", "vision_analyze" not in model_tools._select_tool_names(["vision"], None, True))

    (home / "config.yaml").write_text("agent:\n  disabled_tools: []\n")
    check("an empty list changes nothing", names() == baseline)
    (home / "config.yaml").write_text("agent:\n  reasoning_effort: high\n")
    check("the key absent changes nothing", names() == baseline)
    (home / "config.yaml").write_text("agent: [broken\n")
    check("an unreadable config changes nothing", model_tools._config_disabled_tool_names() == set())

    if failures:
        sys.exit(f"{len(failures)} check(s) failed")
    print("disabled tools: all checks passed")


if __name__ == "__main__":
    main(sys.argv)
