import { describe, expect, it } from "vitest";
import * as database from "./index.js";

describe("database package export graph", () => {
  it("exports the Postgres knowledge search adapter from the package root", () => {
    expect(database.createPgKnowledgeSearchIndex).toEqual(expect.any(Function));
    expect(database.createPgKnowledgeSearchIndex.name).toBe("createPgKnowledgeSearchIndex");
  });
});
