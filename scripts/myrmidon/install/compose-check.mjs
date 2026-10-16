export function composeInterpolation(text, env) {
  // The compose-project equivalent of `docker compose config` that runs with no
  // docker binary: it resolves every ${VAR}, ${VAR:-default}, ${VAR-else},
  // ${VAR:?message} and ${VAR?message} reference the way compose does, reports
  // malformed syntax, and flags a missing required value. A leaked mask or an
  // ellipsis inside a reference fails here — a substring grep never would.
  const errors = [];
  const interpolated = text.replace(/\$\{([^{}]*)\}/g, (whole, body) => {
    const m = body.match(/^([A-Za-z_][A-Za-z0-9_]*)([\s\S]*)$/);
    if (!m) {
      errors.push("malformed reference " + whole);
      return whole;
    }
    const name = m[1];
    const tail = m[2];
    const value = env[name];
    if (tail === "") return value ?? "";
    if (tail.startsWith(":-")) return value || tail.slice(2);
    if (tail.startsWith(":?")) {
      if (!value) errors.push(name + " is required but not set");
      return value ?? "";
    }
    if (tail.startsWith("-")) return value ?? tail.slice(1);
    if (tail.startsWith("?")) {
      if (value === undefined) errors.push(name + " is required but not set");
      return value ?? "";
    }
    errors.push("malformed reference " + whole);
    return whole;
  });
  if (text.includes(String.fromCharCode(0x2026))) {
    errors.push("literal U+2026 in the file (compose-invalid in a substitution)");
  }
  return { errors, interpolated };
}

export function composeEnvVars(text) {
  // deploy.env in the shape compose --env-file reads it: KEY=VALUE, one per
  // line, one pair of surrounding double quotes stripped, no shell semantics.
  const map = {};
  for (const ln of text.split("\n")) {
    const t = ln.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 1) continue;
    let v = t.slice(i + 1);
    if (v.length > 1 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    map[t.slice(0, i)] = v;
  }
  return map;
}
