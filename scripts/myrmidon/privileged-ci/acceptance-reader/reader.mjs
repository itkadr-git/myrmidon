const ISSUE = '(?:[A-Z][A-Z0-9]*-[1-9][0-9]*|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const PATH = new RegExp(`^/api/issues/(${ISSUE})(/documents/acceptance-scenarios)?$`);

export function parsePath(path) {
  const match = PATH.exec(path);
  return match ? { issue: match[1], document: Boolean(match[2]) } : null;
}
