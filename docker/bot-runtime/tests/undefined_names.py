#!/usr/bin/env python3
"""myrmidon(G1): verify no undefined names (pyflakes F821 / NameError on start) in patched modules.

The import smoke in the Dockerfile imports each patched module, but names used inside
methods/functions (like SessionStore in _init_session_store of gateway/run_startup.py)
are only evaluated at call time. Missing imports like #1381 passed top-level import
checks and broke fleet startup. This check statically analyzes all modules modified
by patches/*.patch using pyflakes F821 (or symtable AST analysis) and fails the build
on any undefined name.

Usage: undefined_names.py [<hermes-src>] [<patches-dir>]
"""

from __future__ import annotations

import ast
import builtins
import os
import re
import sys
from pathlib import Path

# Built-in and Python module-level magic variables
MODULE_GLOBALS = frozenset(dir(builtins)) | {
    "__file__",
    "__builtins__",
    "__annotations__",
    "__name__",
    "__doc__",
    "__package__",
    "__spec__",
    "__path__",
    "__cached__",
    "WindowsError",
}


def _try_import_pyflakes():
    """Try to import pyflakes, checking system dist-packages if in virtualenv."""
    try:
        import pyflakes.checker
        import pyflakes.messages
        return pyflakes.checker, pyflakes.messages
    except ImportError:
        pass

    for sys_path in ["/usr/lib/python3/dist-packages", "/usr/local/lib/python3/dist-packages"]:
        if os.path.isdir(sys_path) and sys_path not in sys.path:
            sys.path.insert(0, sys_path)
            try:
                import pyflakes.checker
                import pyflakes.messages
                return pyflakes.checker, pyflakes.messages
            except ImportError:
                pass

    return None, None


def check_undefined_names_pyflakes(code: str, filename: str, pyflakes_mod) -> list[tuple[int, int, str]]:
    """Check undefined names using pyflakes (F821)."""
    checker_cls, msgs_cls = pyflakes_mod
    try:
        tree = ast.parse(code, filename=filename)
    except SyntaxError as e:
        return [(e.lineno or 1, e.offset or 1, f"SyntaxError: {e.msg}")]

    w = checker_cls.Checker(tree, filename=filename)
    results = []
    for m in w.messages:
        if isinstance(m, msgs_cls.UndefinedName):
            results.append((m.lineno, m.col + 1 if hasattr(m, "col") else 1, m.message_args[0]))
    return results


def check_undefined_names_symtable(code: str, filename: str) -> list[tuple[int, int, str]]:
    """Fallback: check undefined names using standard library symtable & AST."""
    import symtable

    try:
        table = symtable.symtable(code, filename, "exec")
    except SyntaxError as e:
        return [(e.lineno or 1, 1, f"SyntaxError: {e.msg}")]

    undefined_names = []

    def check_scope(st):
        for sym in st.get_symbols():
            name = sym.get_name()
            if sym.is_global() and not sym.is_assigned() and not sym.is_imported():
                try:
                    top_sym = table.lookup(name)
                    if top_sym.is_assigned() or top_sym.is_imported():
                        continue
                except KeyError:
                    pass
                if name not in MODULE_GLOBALS:
                    undefined_names.append(name)
        for child in st.get_children():
            check_scope(child)

    check_scope(table)

    if not undefined_names:
        return []

    # Map name occurrences to line numbers using AST
    tree = ast.parse(code, filename=filename)
    results = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
            if node.id in undefined_names:
                results.append((node.lineno, node.col_offset + 1, node.id))

    # Deduplicate while preserving order
    seen = set()
    deduped = []
    for item in results:
        if item not in seen:
            seen.add(item)
            deduped.append(item)
    return deduped


def check_source_undefined_names(code: str, filename: str) -> list[tuple[int, int, str]]:
    """Check undefined names in python source using pyflakes or symtable fallback."""
    checker_cls, msgs_cls = _try_import_pyflakes()
    if checker_cls is not None:
        return check_undefined_names_pyflakes(code, filename, (checker_cls, msgs_cls))
    return check_undefined_names_symtable(code, filename)


def find_patched_python_files(patches_dir: Path) -> set[str]:
    """Parse all .patch files in patches_dir to extract affected Python file paths."""
    py_files = set()
    if not patches_dir.exists():
        return py_files

    for patch_path in patches_dir.glob("*.patch"):
        try:
            content = patch_path.read_text(encoding="utf-8", errors="ignore")
        except Exception as e:
            print(f"warning: failed reading patch {patch_path}: {e}", file=sys.stderr)
            continue

        for line in content.splitlines():
            # Match +++ b/<path>
            if line.startswith("+++ b/"):
                rel = line[6:].strip()
                if rel.endswith(".py"):
                    py_files.add(rel)
            # Match diff --git a/... b/...
            elif line.startswith("diff --git a/"):
                m = re.match(r"^diff --git a/\S+ b/(\S+)$", line)
                if m and m.group(1).endswith(".py"):
                    py_files.add(m.group(1))

    return py_files


def run_regression_test_1381(hermes_root: Path | None = None) -> bool:
    """Verify regression test for #1381: missing SessionStore in run_startup.py must be caught."""
    sample_bad = """
class GatewayServer:
    def _init_session_store(self):
        self.session_store = SessionStore.create_deferred(
            self.session_dir,
            auto_save_interval=self.auto_save_interval,
            run_id=self._run_id_for_startup(),
        )
        self._async_session_store = AsyncSessionStore(self.session_store)
"""
    errors = check_source_undefined_names(sample_bad, "synthetic_bad_run_startup.py")
    found_session_store = any(name == "SessionStore" for _, _, name in errors)
    if not found_session_store:
        print("FAIL: regression check failed to detect undefined SessionStore in synthetic code", file=sys.stderr)
        return False

    sample_good = """
from gateway.session import AsyncSessionStore, SessionStore

class GatewayServer:
    def _init_session_store(self):
        self.session_store = SessionStore.create_deferred(
            self.session_dir,
            auto_save_interval=self.auto_save_interval,
            run_id=self._run_id_for_startup(),
        )
        self._async_session_store = AsyncSessionStore(self.session_store)
"""
    errors_good = check_source_undefined_names(sample_good, "synthetic_good_run_startup.py")
    if errors_good:
        print(f"FAIL: regression check reported unexpected errors on valid code: {errors_good}", file=sys.stderr)
        return False

    if hermes_root:
        real_startup = hermes_root / "gateway" / "run_startup.py"
        if real_startup.exists():
            orig_code = real_startup.read_text(encoding="utf-8")
            # Strip the import as in #1381
            mutated = orig_code.replace("from gateway.session import AsyncSessionStore, SessionStore", "")
            mutated_errors = check_source_undefined_names(mutated, str(real_startup))
            if not any(name == "SessionStore" for _, _, name in mutated_errors):
                print(f"FAIL: mutated {real_startup} without SessionStore import was not caught", file=sys.stderr)
                return False

    return True


def main() -> int:
    if "--regression-test-only" in sys.argv:
        hermes_arg = Path(sys.argv[1]) if len(sys.argv) > 2 and not sys.argv[1].startswith("--") else None
        if run_regression_test_1381(hermes_arg):
            print("regression test #1381: passed")
            return 0
        return 1

    hermes_root_str = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else "/opt/hermes-src"
    hermes_root = Path(hermes_root_str).resolve()

    if len(sys.argv) > 2 and not sys.argv[2].startswith("--"):
        patches_dir = Path(sys.argv[2]).resolve()
    elif Path("/tmp/patches").is_dir():
        patches_dir = Path("/tmp/patches")
    else:
        # Fall back to repo relative directory
        patches_dir = Path(__file__).resolve().parent.parent / "patches"

    # Self-test regression assertion first
    if not run_regression_test_1381(hermes_root):
        print("ERROR: internal regression test #1381 failed", file=sys.stderr)
        return 1

    patched_files = find_patched_python_files(patches_dir)
    if not patched_files:
        print(f"warning: no patched python files found in {patches_dir}", file=sys.stderr)
        return 0

    all_errors: dict[str, list[tuple[int, int, str]]] = {}
    checked_count = 0

    for rel_path in sorted(patched_files):
        target_path = hermes_root / rel_path
        if not target_path.exists():
            # Some patches touch files not in main source tree or test fixtures
            continue

        try:
            code = target_path.read_text(encoding="utf-8")
        except Exception as e:
            print(f"ERROR: failed reading {target_path}: {e}", file=sys.stderr)
            all_errors[rel_path] = [(1, 1, f"ReadError: {e}")]
            continue

        checked_count += 1
        errors = check_source_undefined_names(code, str(target_path))
        if errors:
            all_errors[rel_path] = errors

    if all_errors:
        print(f"::error::found undefined names in {len(all_errors)} patched module(s):", file=sys.stderr)
        for rel_path, errors in all_errors.items():
            for line, col, name in errors:
                print(f"  {rel_path}:{line}:{col}: undefined name '{name}'", file=sys.stderr)
        return 1

    checker_name = "pyflakes" if _try_import_pyflakes()[0] is not None else "symtable (pyflakes-equivalent)"
    print(f"undefined names check: clean across {checked_count} patched modules ({checker_name})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
