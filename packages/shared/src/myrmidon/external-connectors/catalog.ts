// myrmidon(OPE-13019): shared catalog contract for external MCP connectors and
// their actions (OPE-12992 ч.1).
//
// This module is the stable agreement point for later slices: connector
// provider implementations, the authorization/access screen, and UI pickers
// all import these types and validators. It deliberately contains NO
// execution, NO provider logic, NO persistence and NO HTTP routes — only
// catalog metadata, identifiers, validation, and helper predicates.
//
// Identifier rules (enforced by the schemas below):
//   connectorId: `[a-z0-9][a-z0-9-]*` (kebab-case slug), unique per catalog.
//   actionId:    `[a-z][a-z0-9]*(:[a-z][a-z0-9]*)*` (colon-scoped camel),
//                unique within its connector.
//
// Permissions are declarative capability strings (`domain:resource:level`,
// e.g. `bitrix24:task:read`). The access screen and the authorization slice
// match grants against these required permissions; this module does not
// resolve them.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Identifier formats
// ---------------------------------------------------------------------------

/** Kebab-case slug used as the stable connector identifier. No leading/trailing hyphen. */
export const CONNECTOR_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Colon-scoped camel identifier used as the stable action identifier. */
export const CONNECTOR_ACTION_ID_PATTERN = /^[a-z][a-z0-9]*(:[a-z][a-z0-9]*)*$/;

/** Declarative capability string: `domain:resource:level`. */
export const CONNECTOR_PERMISSION_PATTERN = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/;

export const connectorIdSchema = z
  .string()
  .min(1, "connectorId must not be empty")
  .max(64, "connectorId must be at most 64 characters")
  .regex(CONNECTOR_ID_PATTERN, "connectorId must be a kebab-case slug ([a-z0-9][a-z0-9-]*)");

export const connectorActionIdSchema = z
  .string()
  .min(1, "actionId must not be empty")
  .max(128, "actionId must be at most 128 characters")
  .regex(
    CONNECTOR_ACTION_ID_PATTERN,
    "actionId must be colon-scoped camelCase ([a-z][a-z0-9]*(:[a-z][a-z0-9]*)*)",
  );

export const connectorPermissionSchema = z
  .string()
  .min(1, "permission must not be empty")
  .max(128, "permission must be at most 128 characters")
  .regex(
    CONNECTOR_PERMISSION_PATTERN,
    "permission must look like domain:resource:level",
  );

// ---------------------------------------------------------------------------
// Action descriptor
// ---------------------------------------------------------------------------

/** Human-readable labels for the action access modes surfaced on the rights screen. */
export const CONNECTOR_ACTION_MODES = ["read", "write", "confirm"] as const;
export type ConnectorActionMode = (typeof CONNECTOR_ACTION_MODES)[number];

export const connectorActionModeSchema = z.enum(CONNECTOR_ACTION_MODES);

export const connectorActionSchema = z
  .object({
    /** Stable action identifier, unique within the connector. */
    id: connectorActionIdSchema,
    /** Short human-readable label, e.g. "Read task". */
    title: z.string().min(1, "action title must not be empty").max(120),
    /** One-paragraph description of what the action does and on what data. */
    description: z
      .string()
      .min(10, "action description must be at least 10 characters")
      .max(2000),
    /** Default access mode for the action. */
    mode: connectorActionModeSchema,
    /** Permissions an agent must hold to invoke the action. Non-empty. */
    requiredPermissions: z
      .array(connectorPermissionSchema)
      .min(1, "requiredPermissions must list at least one permission"),
  })
  .strict();

export type ConnectorAction = z.infer<typeof connectorActionSchema>;

// ---------------------------------------------------------------------------
// Connector catalog entry
// ---------------------------------------------------------------------------

/** Transport kinds a connector may declare. MCP is the primary target. */
export const CONNECTOR_TRANSPORT_KINDS = ["mcp", "rest"] as const;
export type ConnectorTransportKind = (typeof CONNECTOR_TRANSPORT_KINDS)[number];

export const connectorTransportKindSchema = z.enum(CONNECTOR_TRANSPORT_KINDS);

export const connectorCatalogEntrySchema = z
  .object({
    /** Stable connector identifier, unique across the catalog. */
    id: connectorIdSchema,
    /** Human-readable connector name, e.g. "Bitrix24". */
    displayName: z.string().min(1).max(120),
    /** One-paragraph description of what the connector exposes. */
    description: z.string().min(10).max(2000),
    transport: connectorTransportKindSchema,
    /** Actions the connector exposes; ids must be unique within the entry. */
    actions: z
      .array(connectorActionSchema)
      .min(1, "connector must declare at least one action"),
  })
  .strict()
  .superRefine((entry, ctx) => {
    const seen = new Set<string>();
    for (const action of entry.actions) {
      if (seen.has(action.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate action id "${action.id}" in connector "${entry.id}"`,
          path: ["actions"],
        });
      }
      seen.add(action.id);
    }
  });

export type ConnectorCatalogEntry = z.infer<typeof connectorCatalogEntrySchema>;

// ---------------------------------------------------------------------------
// Catalog document
// ---------------------------------------------------------------------------

export const CONNECTOR_CATALOG_SCHEMA_ID = "paperclip.connector_catalog.v1";

export const connectorCatalogSchema = z
  .object({
    schema: z.literal(CONNECTOR_CATALOG_SCHEMA_ID),
    catalogVersion: z
      .number()
      .int("catalogVersion must be an integer")
      .nonnegative("catalogVersion must be non-negative"),
    connectors: z.array(connectorCatalogEntrySchema),
  })
  .strict()
  .superRefine((catalog, ctx) => {
    const seen = new Set<string>();
    for (const connector of catalog.connectors) {
      if (seen.has(connector.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate connector id "${connector.id}" in catalog`,
          path: ["connectors"],
        });
      }
      seen.add(connector.id);
    }
  });

export type ConnectorCatalog = z.infer<typeof connectorCatalogSchema>;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** Parse-and-throw for a single catalog entry. Throws ZodError on invalid input. */
export function parseConnectorCatalogEntry(raw: unknown): ConnectorCatalogEntry {
  return connectorCatalogEntrySchema.parse(raw);
}

/** Safe-parse for a single catalog entry. */
export function safeParseConnectorCatalogEntry(raw: unknown) {
  return connectorCatalogEntrySchema.safeParse(raw);
}

/** Parse-and-throw for a full catalog document. */
export function parseConnectorCatalog(raw: unknown): ConnectorCatalog {
  return connectorCatalogSchema.parse(raw);
}

/** Safe-parse for a full catalog document. */
export function safeParseConnectorCatalog(raw: unknown) {
  return connectorCatalogSchema.safeParse(raw);
}

/** Collect every required permission declared by a catalog entry, deduplicated. */
export function collectConnectorPermissions(entry: ConnectorCatalogEntry): string[] {
  const out = new Set<string>();
  for (const action of entry.actions) {
    for (const perm of action.requiredPermissions) {
      out.add(perm);
    }
  }
  return [...out].sort();
}

/** True when `permission` satisfies one of `required` (string equality). */
export function permissionSatisfies(required: string, permission: string): boolean {
  return required === permission;
}

/** True when the granted set covers every required permission of the action. */
export function actionPermissionsSatisfied(
  action: ConnectorAction,
  grantedPermissions: readonly string[],
): boolean {
  const granted = new Set(grantedPermissions);
  return action.requiredPermissions.every((required) =>
    [...granted].some((perm) => permissionSatisfies(required, perm)),
  );
}
