export function extractH1(content: string): string | null {
  const match = content.match(/^#\s+(.+)$/m);
  if (!match) return null;
  return match[1].trim();
}

export function getLastSegment(slug: string): string {
  const parts = slug.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1]! : slug;
}
