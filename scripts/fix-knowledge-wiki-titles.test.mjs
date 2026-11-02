import assert from "node:assert/strict";
import test from "node:test";
import { extractH1, getLastSegment } from "./fix-knowledge-wiki-titles-lib.ts";

test("getLastSegment extracts the last segment of hierarchical slugs", () => {
  assert.equal(getLastSegment("overview"), "overview");
  assert.equal(getLastSegment("wiki/overview"), "overview");
  assert.equal(getLastSegment("wiki/docs/architecture/structure"), "structure");
  assert.equal(getLastSegment("/nested/path/"), "path");
});

test("extractH1 extracts the first markdown H1 header from content", () => {
  const content = "# Architecture Overview\n\nSome text here\n## Subheading";
  assert.equal(extractH1(content), "Architecture Overview");
});

test("extractH1 ignores content without H1 or leading text before H1", () => {
  const content = "Some intro text\n\n# Real Header\n\nBody";
  assert.equal(extractH1(content), "Real Header");
});

test("extractH1 returns null when no H1 is present", () => {
  const content = "## Subheading\n\n### Minor";
  assert.equal(extractH1(content), null);
});

test("extractH1 trims whitespace around the header", () => {
  const content = "#    Trimmed Title   \n\nBody";
  assert.equal(extractH1(content), "Trimmed Title");
});
