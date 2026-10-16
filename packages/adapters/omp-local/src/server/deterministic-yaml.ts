export type YamlScalar = string | number | boolean;
export type YamlNode = YamlScalar | undefined | null | readonly YamlNode[] | { readonly [key: string]: YamlNode };
export type YamlMapping = { readonly [key: string]: YamlNode };

const BARE_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

const YAML_11_RESERVED_KEYS = new Set([
  "on", "off", "yes", "no", "y", "n", "true", "false", "null", "~",
]);

function isPlainObject(value: YamlNode): value is YamlMapping {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isArrayNode(value: YamlNode): value is readonly YamlNode[] {
  return Array.isArray(value);
}

function renderScalar(value: YamlScalar): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (!Number.isFinite(value)) {
    throw new Error(`deterministic-yaml: refusing to render non-finite number ${String(value)}`);
  }
  return String(value);
}

function renderKey(key: string): string {
  const bare = BARE_KEY_PATTERN.test(key) && !YAML_11_RESERVED_KEYS.has(key.toLowerCase());
  return bare ? key : JSON.stringify(key);
}

function sortedDefinedEntries(mapping: YamlMapping): Array<[string, YamlNode]> {
  return Object.keys(mapping)
    .filter((key) => mapping[key] !== undefined && mapping[key] !== null)
    .sort()
    .map((key): [string, YamlNode] => [key, mapping[key] as YamlNode]);
}

function renderMapping(mapping: YamlMapping, indent: number, lines: string[]): void {
  const pad = " ".repeat(indent);
  for (const [key, value] of sortedDefinedEntries(mapping)) {
    if (isPlainObject(value)) {
      const nested: string[] = [];
      renderMapping(value, indent + 2, nested);
      if (nested.length === 0) continue;
      lines.push(`${pad}${renderKey(key)}:`);
      lines.push(...nested);
    } else if (isArrayNode(value)) {
      if (value.length === 0) continue;
      lines.push(`${pad}${renderKey(key)}:`);
      renderSequence(value, indent + 2, lines);
    } else if (value !== undefined && value !== null) {
      lines.push(`${pad}${renderKey(key)}: ${renderScalar(value)}`);
    }
  }
}

function renderSequence(items: readonly YamlNode[], indent: number, lines: string[]): void {
  const pad = " ".repeat(indent);
  for (const item of items) {
    if (item === undefined || item === null) continue;
    if (isArrayNode(item)) {
      throw new Error("deterministic-yaml: nested sequences are not supported");
    }
    if (isPlainObject(item)) {
      const nested: string[] = [];
      renderMapping(item, indent + 2, nested);
      if (nested.length === 0) continue;
      // First line of mapping gets "- " prefix
      const firstLine = nested[0].trimStart();
      lines.push(`${pad}- ${firstLine}`);
      for (let i = 1; i < nested.length; i++) {
        lines.push(nested[i]);
      }
    } else {
      lines.push(`${pad}- ${renderScalar(item)}`);
    }
  }
}

export function writeYamlDocument(root: YamlMapping): string {
  const lines: string[] = [];
  renderMapping(root, 0, lines);
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}
