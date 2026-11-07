import { z } from \"zod\";
import {
  ISSUE_ACCEPTANCE_SCENARIOS_DOCUMENT_KEY,
  type IssueAcceptanceScenariosDocumentKey,
} from \"../constants.js\";

export { ISSUE_ACCEPTANCE_SCENARIOS_DOCUMENT_KEY, type IssueAcceptanceScenariosDocumentKey };

/**
 * Acceptance scenario test reference schema.
 * Represents a pointer to automated or manual verification: a file path or structured reference.
 */
export const acceptanceScenarioTestRefSchema = z.union([
  z.string().min(1),
  z.object({
    path: z.string().min(1),
    testName: z.string().optional(),
    suite: z.string().optional(),
    line: z.number().int().positive().optional(),
  }).strict(),
]);
export type AcceptanceScenarioTestRef = z.infer<typeof acceptanceScenarioTestRefSchema>;

/**
 * Acceptance scenario contract.
 *
 * Implements the scenario-vs-test separation principle:
 * acceptance criteria define what the system must do from an external observer's
 * perspective and, crucially, under what observable conditions the implementation
 * must be rejected ("falsifiedWhen").
 *
 * Scenarios live in the issue document (outside feature PR branches) to prevent
 * weakening of acceptance gates during implementation.
 */
export const acceptanceScenarioSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().optional(),
    given: z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
    when: z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
    then: z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
    falsifiedWhen: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    testRefs: z.array(acceptanceScenarioTestRefSchema).default([]),
    tags: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type AcceptanceScenario = z.infer<typeof acceptanceScenarioSchema>;

/**
 * Task document schema for acceptance-scenarios storage.
 */
export const acceptanceScenariosDocumentSchema = z
  .object({
    version: z.number().int().positive().default(1),
    scenarios: z.array(acceptanceScenarioSchema),
    epicKey: z.string().optional(),
    epicIdentifier: z.string().optional(),
    issueIdentifier: z.string().optional(),
    updatedAt: z.string().optional(),
    notes: z.string().optional(),
  })
  .strict();
export type AcceptanceScenariosDocument = z.infer<typeof acceptanceScenariosDocumentSchema>;

export const acceptanceScenariosPayloadSchema = z.union([
  acceptanceScenariosDocumentSchema,
  z.array(acceptanceScenarioSchema),
]);
export type AcceptanceScenariosPayload = z.infer<typeof acceptanceScenariosPayloadSchema>;

/**
 * Type guard for an individual acceptance scenario.
 */
export function isAcceptanceScenario(value: unknown): value is AcceptanceScenario {
  return acceptanceScenarioSchema.safeParse(value).success;
}

/**
 * Parse and validate a single acceptance scenario.
 */
export function parseAcceptanceScenario(raw: unknown): AcceptanceScenario {
  return acceptanceScenarioSchema.parse(raw);
}

/**
 * Parse an array of scenarios from raw input (array, JSON string, or document wrapper).
 */
export function parseAcceptanceScenarios(raw: unknown): AcceptanceScenario[] {
  let payload = raw;
  if (typeof payload === \"string\") {
    try {
      payload = JSON.parse(payload);
    } catch {
      throw new Error(\"Invalid JSON for acceptance scenarios\");
    }
  }

  if (Array.isArray(payload)) {
    return z.array(acceptanceScenarioSchema).parse(payload);
  }

  if (payload && typeof payload === \"object\") {
    const doc = acceptanceScenariosDocumentSchema.parse(payload);
    return doc.scenarios;
  }

  throw new Error(\"Invalid acceptance scenarios payload: expected array or document object\");
}

/**
 * Parse an acceptance scenarios document from raw input.
 */
export function parseAcceptanceScenariosDocument(raw: unknown): AcceptanceScenariosDocument {
  let payload = raw;
  if (typeof payload === \"string\") {
    try {
      payload = JSON.parse(payload);
    } catch {
      throw new Error(\"Invalid JSON for acceptance scenarios document\");
    }
  }

  if (Array.isArray(payload)) {
    const scenarios = z.array(acceptanceScenarioSchema).parse(payload);
    return {
      version: 1,
      scenarios,
    };
  }

  return acceptanceScenariosDocumentSchema.parse(payload);
}
