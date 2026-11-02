# myrmidon(G1): build-time regression for 19-redact-auth-bearer-template-syntax.patch.
# Authorization header redaction must not false-positive on code templates (${...},
# <...>, {...}), variable identifiers (token, authToken, $token) or backtick template
# literals, while real high-entropy credentials (e.g. `Bearer ghp_...` 36+ chars)
# must still be masked safely without syntax corruption.
#
# Usage: auth_header_redact_templates.py <hermes-src>   (e.g. /opt/hermes-src)

import sys

sys.path.insert(0, sys.argv[1] if len(sys.argv) > 1 else "/opt/hermes-src")

from agent.redact import redact_sensitive_text  # noqa: E402

failures: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    if not condition:
        msg = f"{name}: {detail}" if detail else name
        failures.append(msg)
        print(f"FAIL: {msg}")
    else:
        print(f"OK: {name}")


# 1. Requirement 4: Literal `Bearer ${token}` stays as is
input_bearer_template = "Authorization: Bearer ${token}"
out_bearer_template = redact_sensitive_text(input_bearer_template)
check(
    "literal Bearer ${token} remains unchanged",
    out_bearer_template == input_bearer_template,
    f"expected {input_bearer_template!r}, got {out_bearer_template!r}",
)

# 2. Requirement 4: `Bearer ghp_...` (36+ chars) is masked
# Note: Assemble dynamically to avoid triggering static secret scanners (gitleaks).
ghp_prefix = "gh" + "p_"
ghp_token = ghp_prefix + "".join(chr(ord("0") + (i % 10)) for i in range(36))
input_ghp = f"Authorization: Bearer {ghp_token}"
out_ghp = redact_sensitive_text(input_ghp)
check(
    "Bearer ghp_... (36+ chars) is masked",
    ghp_token not in out_ghp and "Authorization: Bearer " in out_ghp,
    f"got {out_ghp!r}",
)

# 3. Code template literal from PR #2060 / commit dafd419b2 (github-ci.ts:54)
ts_code_line = "    ...(token ? { authorization: `Bearer ${token}` } : {}),"
out_ts_code = redact_sensitive_text(ts_code_line)
check(
    "TypeScript template string with backticks preserved without syntax corruption",
    out_ts_code == ts_code_line,
    f"expected {ts_code_line!r}, got {out_ts_code!r}",
)

# 4. Requirement 2: Placeholders and variable names preserved
test_cases_preserved = [
    ("Authorization: Bearer <token>", "Authorization: Bearer <token>"),
    ("Authorization: Bearer <YOUR_API_TOKEN>", "Authorization: Bearer <YOUR_API_TOKEN>"),
    ("Authorization: Bearer $token", "Authorization: Bearer $token"),
    ("Authorization: Bearer $AUTH_TOKEN", "Authorization: Bearer $AUTH_TOKEN"),
    ("Authorization: Bearer token", "Authorization: Bearer token"),
    ("Authorization: Bearer authToken", "Authorization: Bearer authToken"),
    ("Authorization: Bearer accessToken", "Authorization: Bearer accessToken"),
    ("Authorization: Bearer {token}", "Authorization: Bearer {token}"),
    (
        "headers: { Authorization: `Bearer ${config.llm.apiKey}` }",
        "headers: { Authorization: `Bearer ${config.llm.apiKey}` }",
    ),
    (
        'headers["Authorization"] = `Bearer ${process.env.API_KEY}`;',
        'headers["Authorization"] = `Bearer ${process.env.API_KEY}`;',
    ),
]

for src, expected in test_cases_preserved:
    res = redact_sensitive_text(src)
    check(
        f"preserve code template/identifier: {src}",
        res == expected,
        f"expected {expected!r}, got {res!r}",
    )

# 5. Requirement 2 & 4: Real secrets are masked
# Note: Assemble dynamically to avoid triggering static secret scanners (gitleaks).
jwt_part1 = "eyJ" + "hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
jwt_part2 = "eyJ" + "zdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ"
jwt_part3 = "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
synthetic_jwt = f"{jwt_part1}.{jwt_part2}.{jwt_part3}"
out_jwt = redact_sensitive_text(f"Authorization: Bearer {synthetic_jwt}")
check(
    "JWT bearer token is masked",
    synthetic_jwt not in out_jwt and "Authorization: Bearer " in out_jwt,
    f"got {out_jwt!r}",
)

alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
opaque_token = "".join(alphabet[(i * 7 + 3) % len(alphabet)] for i in range(36))
out_opaque = redact_sensitive_text(f"Authorization: Bearer {opaque_token}")
check(
    "high-entropy opaque token is masked",
    opaque_token not in out_opaque and "Authorization: Bearer " in out_opaque,
    f"got {out_opaque!r}",
)

# 6. Real secret inside backticks preserves backtick syntax while masking secret
out_quoted_secret = redact_sensitive_text(f"authorization: `Bearer {ghp_token}`")
check(
    "secret inside backticks is masked while preserving backticks",
    ghp_token not in out_quoted_secret
    and out_quoted_secret.startswith("authorization: `Bearer ")
    and out_quoted_secret.endswith("`"),
    f"got {out_quoted_secret!r}",
)

if failures:
    print(f"\nTotal failures: {len(failures)}")
    sys.exit(1)

print("\nOK: all authorization header template redaction checks passed")
