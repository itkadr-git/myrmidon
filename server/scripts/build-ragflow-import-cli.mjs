import esbuild from "esbuild";
import { readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(__dirname, "..");
const repoRoot = resolve(serverRoot, "..");
const entryPoint = resolve(repoRoot, "scripts/myrmidon/ragflow-corpus-import.ts");
const outDir = resolve(serverRoot, "dist/scripts");
const outFile = resolve(outDir, "ragflow-corpus-import.js");

mkdirSync(outDir, { recursive: true });

function readPkg(pkgPath) {
  try {
    return JSON.parse(readFileSync(pkgPath, "utf-8"));
  } catch {
    return {};
  }
}

const rootPkg = readPkg(resolve(repoRoot, "package.json"));
const serverPkg = readPkg(resolve(serverRoot, "package.json"));

const allDeps = new Set([
  ...Object.keys(rootPkg.dependencies || {}),
  ...Object.keys(rootPkg.devDependencies || {}),
  ...Object.keys(serverPkg.dependencies || {}),
  ...Object.keys(serverPkg.devDependencies || {}),
  "drizzle-orm",
  "postgres",
]);

const externals = Array.from(allDeps).filter((dep) => !dep.startsWith("@myrmidon/"));

await esbuild.build({
  entryPoints: [entryPoint],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  outfile: outFile,
  banner: { js: "#!/usr/bin/env node\n" },
  external: externals,
  treeShaking: true,
  sourcemap: true,
});

console.log(`[build-ragflow-import-cli] Built ${outFile}`);
