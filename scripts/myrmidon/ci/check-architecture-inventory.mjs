#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const adrDir = join(repoRoot, "docs/architecture/adr");
const seedData = readFileSync(join(repoRoot, "server/src/myrmidon/knowledge/seed-data.ts"), "utf8");
const adrFiles = readdirSync(adrDir).filter((file) => /^ADR-\d{4}-.+\.md$/.test(file));
const registrySlugs = [...seedData.matchAll(/^\s+slug: "(decisions\/[^\"]+)"/gm)].map((match) => match[1]);
const productAdrs = adrFiles.map((file) => readFileSync(join(adrDir, file), "utf8")).filter((text) => text.includes("Registry: OPE-401"));
const sources = productAdrs.flatMap((text) => [...text.matchAll(/Registry: OPE-401 \(`([^`]+)`\)/g)].map((match) => match[1]));
const errors = [];
if (new Set(registrySlugs).size !== registrySlugs.length) errors.push("OPE-401 registry contains duplicate decision slugs");
if (new Set(sources).size !== sources.length) errors.push("ADR inventory contains duplicate OPE-401 sources");
for (const slug of registrySlugs) if (!sources.includes(slug)) errors.push(`missing ADR for ${slug}`);
for (const slug of sources) if (!registrySlugs.includes(slug)) errors.push(`ADR references unknown OPE-401 decision ${slug}`);
if (sources.length !== registrySlugs.length) errors.push(`ADR inventory count ${sources.length} does not match registry count ${registrySlugs.length}`);
if (errors.length) {
  console.error(errors.map((error) => `ARCH-ADR: ${error}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`ARCH-ADR: OPE-401 inventory complete (${sources.length} decisions)`);
}
