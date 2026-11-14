// packages/shared/src/myrmidon/external-connectors.test.ts
//
// OPE-13019 (OPE-12992 ч.1): behavior tests for the shared external-connector
// catalog contract. Each acceptance criterion from the issue maps to a test
// block below.

import { describe, expect, it } from "vitest";
import {
  CONNECTOR_ACTION_MODES,
  CONNECTOR_CATALOG_SCHEMA_ID,
  CONNECTOR_TRANSPORT_KINDS,
  actionPermissionsSatisfied,
  collectConnectorPermissions,
  connectorCatalogEntrySchema,
  connectorCatalogSchema,
  parseConnectorCatalog,
  parseConnectorCatalogEntry,
  safeParseConnectorCatalog,
  safeParseConnectorCatalogEntry,
} from "./external-connectors/index.js";

const validAction = {
  id: "task:read",
  title: "Read task",
  description: "Reads a single Bitrix24 task by id, including its comments.",
  mode: "read",
  requiredPermissions: ["bitrix24:task:read"],
};

const validEntry = {
  id: "bitrix24",
  displayName: "Bitrix24",
  description:
    "Connector to Bitrix24 over MCP: tasks, deals and comments for agent workflows.",
  transport: "mcp",
  actions: [validAction],
};

const validCatalog = {
  schema: CONNECTOR_CATALOG_SCHEMA_ID,
  catalogVersion: 1,
  connectors: [validEntry],
};

describe("myrmidon(OPE-13019) external-connector catalog contract", () => {
  describe("accepted catalog entries", () => {
    it("accepts a minimal valid entry with one action and one required permission", () => {
      const parsed = parseConnectorCatalogEntry(validEntry);
      expect(parsed.id).toBe("bitrix24");
      expect(parsed.actions).toHaveLength(1);
      expect(parsed.actions[0].requiredPermissions).toEqual(["bitrix24:task:read"]);
    });

    it("accepts an entry with multiple actions and multiple permissions per action", () => {
      const entry = {
        ...validEntry,
        actions: [
          validAction,
          {
            id: "deal:create",
            title: "Create deal",
            description: "Creates a new Bitrix24 deal in the specified pipeline stage.",
            mode: "confirm",
            requiredPermissions: ["bitrix24:deal:write", "bitrix24:pipeline:read"],
          },
        ],
      };
      const result = safeParseConnectorCatalogEntry(entry);
      expect(result.success).toBe(true);
    });

    it("round-trips a valid catalog document through parseConnectorCatalog", () => {
      const parsed = parseConnectorCatalog(validCatalog);
      expect(parsed.catalogVersion).toBe(1);
      expect(parsed.connectors).toHaveLength(1);
      expect(parsed.connectors[0].id).toBe("bitrix24");
    });

    it("exposes the transport kinds and action modes the parent scope requires", () => {
      expect(CONNECTOR_TRANSPORT_KINDS).toContain("mcp");
      expect(CONNECTOR_TRANSPORT_KINDS).toContain("rest");
      expect(CONNECTOR_ACTION_MODES).toEqual(["read", "write", "confirm"]);
    });
  });

  describe("invalid connector ids", () => {
    it.each([
      ["empty string", ""],
      ["uppercase", "Bitrix24"],
      ["leading hyphen", "-bitrix24"],
      ["trailing hyphen", "bitrix24-"],
      ["underscore", "bitrix_24"],
      ["space", "bitrix 24"],
      ["over 64 chars", "a".repeat(65)],
    ])("rejects connector id %s", (_label, id) => {
      const result = safeParseConnectorCatalogEntry({ ...validEntry, id });
      expect(result.success).toBe(false);
    });
  });

  describe("invalid action ids", () => {
    it.each([
      ["empty string", ""],
      ["uppercase", "Task:Read"],
      ["leading colon", ":read"],
      ["trailing colon", "task:"],
      ["double colon", "task::read"],
      ["hyphen in segment", "task-read"],
      ["over 128 chars", `a:${"b".repeat(130)}`],
    ])("rejects action id %s", (_label, actionId) => {
      const entry = {
        ...validEntry,
        actions: [{ ...validAction, id: actionId }],
      };
      const result = safeParseConnectorCatalogEntry(entry);
      expect(result.success).toBe(false);
    });
  });

  describe("invalid permission strings", () => {
    it.each([
      ["missing level", "bitrix24:task"],
      ["single token", "bitrix24"],
      ["empty segment", "bitrix24::read"],
      ["uppercase", "Bitrix24:Task:Read"],
      ["trailing colon", "bitrix24:task:"],
    ])("rejects permission %s", (_label, permission) => {
      const entry = {
        ...validEntry,
        actions: [{ ...validAction, requiredPermissions: [permission] }],
      };
      const result = safeParseConnectorCatalogEntry(entry);
      expect(result.success).toBe(false);
    });
  });

  describe("missing descriptions", () => {
    it("rejects an entry with an empty connector description", () => {
      const result = safeParseConnectorCatalogEntry({ ...validEntry, description: "" });
      expect(result.success).toBe(false);
    });

    it("rejects an entry with a too-short connector description", () => {
      const result = safeParseConnectorCatalogEntry({ ...validEntry, description: "short" });
      expect(result.success).toBe(false);
    });

    it("rejects an action with an empty description", () => {
      const entry = {
        ...validEntry,
        actions: [{ ...validAction, description: "" }],
      };
      const result = safeParseConnectorCatalogEntry(entry);
      expect(result.success).toBe(false);
    });

    it("rejects an action with a too-short description", () => {
      const entry = {
        ...validEntry,
        actions: [{ ...validAction, description: "tiny" }],
      };
      const result = safeParseConnectorCatalogEntry(entry);
      expect(result.success).toBe(false);
    });
  });

  describe("missing permissions", () => {
    it("rejects an action with an empty requiredPermissions list", () => {
      const entry = {
        ...validEntry,
        actions: [{ ...validAction, requiredPermissions: [] }],
      };
      const result = safeParseConnectorCatalogEntry(entry);
      expect(result.success).toBe(false);
    });

    it("rejects an action with a missing requiredPermissions field", () => {
      const { requiredPermissions: _omitted, ...actionNoPerms } = validAction;
      const entry = { ...validEntry, actions: [actionNoPerms] };
      const result = safeParseConnectorCatalogEntry(entry);
      expect(result.success).toBe(false);
    });
  });

  describe("duplicate ids", () => {
    it("rejects an entry with duplicate action ids", () => {
      const entry = {
        ...validEntry,
        actions: [validAction, { ...validAction, title: "Read task (alias)" }],
      };
      const result = safeParseConnectorCatalogEntry(entry);
      expect(result.success).toBe(false);
    });

    it("rejects a catalog with duplicate connector ids", () => {
      const catalog = {
        ...validCatalog,
        connectors: [validEntry, { ...validEntry, displayName: "Bitrix24 copy" }],
      };
      const result = safeParseConnectorCatalog(catalog);
      expect(result.success).toBe(false);
    });

    it("accepts the same action id across different connectors in one catalog", () => {
      const oneC = {
        id: "onec",
        displayName: "1C",
        description:
          "Connector to 1C over OData: reads catalogs and documents from a configured infobase.",
        transport: "rest",
        actions: [
          {
            id: "catalog:read",
            title: "Read catalog",
            description: "Reads entries of a named 1C catalog via its OData feed.",
            mode: "read",
            requiredPermissions: ["onec:catalog:read"],
          },
        ],
      };
      const catalog = {
        schema: CONNECTOR_CATALOG_SCHEMA_ID,
        catalogVersion: 2,
        connectors: [validEntry, oneC],
      };
      const result = safeParseConnectorCatalog(catalog);
      expect(result.success).toBe(true);
    });
  });

  describe("strict shape", () => {
    it("rejects unknown fields on the entry", () => {
      const result = safeParseConnectorCatalogEntry({ ...validEntry, extra: true });
      expect(result.success).toBe(false);
    });

    it("rejects unknown fields on an action", () => {
      const entry = {
        ...validEntry,
        actions: [{ ...validAction, undocumented: 1 }],
      };
      const result = safeParseConnectorCatalogEntry(entry);
      expect(result.success).toBe(false);
    });

    it("rejects a catalog with the wrong schema literal", () => {
      const result = safeParseConnectorCatalog({ ...validCatalog, schema: "paperclip.other.v9" });
      expect(result.success).toBe(false);
    });
  });

  describe("permission helpers", () => {
    it("collectConnectorPermissions deduplicates and sorts", () => {
      const entry = {
        ...validEntry,
        actions: [
          validAction,
          {
            id: "deal:create",
            title: "Create deal",
            description: "Creates a new Bitrix24 deal in the specified pipeline stage.",
            mode: "confirm",
            requiredPermissions: ["bitrix24:deal:write", "bitrix24:task:read"],
          },
        ],
      };
      const parsed = connectorCatalogEntrySchema.parse(entry);
      expect(collectConnectorPermissions(parsed)).toEqual([
        "bitrix24:deal:write",
        "bitrix24:task:read",
      ]);
    });

    it("actionPermissionsSatisfied returns true when every required permission is granted", () => {
      const parsed = connectorCatalogEntrySchema.parse(validEntry);
      expect(actionPermissionsSatisfied(parsed.actions[0], ["bitrix24:task:read"])).toBe(true);
      expect(
        actionPermissionsSatisfied(parsed.actions[0], [
          "bitrix24:task:read",
          "bitrix24:deal:write",
        ]),
      ).toBe(true);
    });

    it("actionPermissionsSatisfied returns false when a required permission is missing", () => {
      const parsed = connectorCatalogEntrySchema.parse(validEntry);
      expect(actionPermissionsSatisfied(parsed.actions[0], [])).toBe(false);
      expect(actionPermissionsSatisfied(parsed.actions[0], ["bitrix24:deal:write"])).toBe(
        false,
      );
    });
  });

  describe("schema exports are wired", () => {
    it("connectorCatalogEntrySchema and connectorCatalogSchema are exported", () => {
      expect(typeof connectorCatalogEntrySchema.safeParse).toBe("function");
      expect(typeof connectorCatalogSchema.safeParse).toBe("function");
    });
  });
});
