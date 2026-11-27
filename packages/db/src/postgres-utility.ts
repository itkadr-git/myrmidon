export async function createUtilitySql(url: string) {
  const { default: postgres } = await import("postgres");
  return postgres(url, { max: 1, onnotice: () => {} });
}

function isSafeIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

export function quoteIdentifier(value: string): string {
  if (!isSafeIdentifier(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
  return `"${value.replaceAll("\"", "\"\"")}"`;
}
