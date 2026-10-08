// myrmidon(CORPUS-2.0): embedding vector helpers.
//
// The corpus stores embeddings of the company gateway's text-embedding model: 1024
// dimensions, L2-normalized, compared by cosine distance (`<=>` in pgvector). The helpers
// here keep the three rules in one place: the vector has the right size, its numbers are
// finite, and it is normalized before it is written or queried.

export const CORPUS_EMBEDDING_DIMENSIONS = 1024;

export type EmbeddingVectorErrorCode = "empty" | "dimension" | "value";

export class EmbeddingVectorError extends Error {
  readonly code: EmbeddingVectorErrorCode;

  constructor(code: EmbeddingVectorErrorCode, message: string) {
    super(message);
    this.name = "EmbeddingVectorError";
    this.code = code;
  }
}

/** Validates an embedding and returns it unchanged, so calls can read as assertions. */
export function assertEmbeddingVector(
  vector: readonly number[],
  dimensions: number = CORPUS_EMBEDDING_DIMENSIONS,
): readonly number[] {
  if (vector.length === 0) throw new EmbeddingVectorError("empty", "embedding vector is empty");
  if (vector.length !== dimensions) {
    throw new EmbeddingVectorError(
      "dimension",
      `embedding vector has ${vector.length} dimensions, expected ${dimensions}`,
    );
  }
  assertFiniteVector(vector);
  return vector;
}

/** Width-independent guard: used wherever a vector is serialized for the database. */
function assertFiniteVector(vector: readonly number[]): void {
  if (vector.length === 0) throw new EmbeddingVectorError("empty", "embedding vector is empty");
  for (const value of vector) {
    if (!Number.isFinite(value)) {
      throw new EmbeddingVectorError("value", "embedding vector contains a non-finite number");
    }
  }
}

export function l2Norm(vector: readonly number[]): number {
  let sum = 0;
  for (const value of vector) sum += value * value;
  return Math.sqrt(sum);
}

/** Scales a vector to unit length. Cosine distance is only meaningful for such vectors. */
export function l2Normalize(vector: readonly number[]): number[] {
  const norm = l2Norm(vector);
  if (norm === 0) throw new EmbeddingVectorError("value", "embedding vector has zero norm");
  return vector.map((value) => value / norm);
}

/** True when the vector is already (approximately) unit length, within `tolerance`. */
export function isL2Normalized(vector: readonly number[], tolerance = 1e-3): boolean {
  return Math.abs(l2Norm(vector) - 1) <= tolerance;
}

/** pgvector text literal, e.g. `[0.1,0.2]`. Used as a bound query parameter. */
export function toPgVectorLiteral(vector: readonly number[]): string {
  // Deliberately width-independent: the embedding width is a module setting, and the stand may
  // run narrower vectors than the product default.
  assertFiniteVector(vector);
  return `[${vector.map((value) => formatComponent(value)).join(",")}]`;
}

function formatComponent(value: number): string {
  if (Number.isInteger(value)) return String(value);
  const rendered = value.toFixed(8).replace(/0+$/, "");
  return rendered.endsWith(".") ? `${rendered}0` : rendered;
}

/** Cosine similarity in [-1, 1]; pair-wise check for tests and in-memory harnesses. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new EmbeddingVectorError("dimension", "vectors have different sizes");
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  if (normA === 0 || normB === 0) throw new EmbeddingVectorError("value", "cosine similarity of a zero vector");
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}