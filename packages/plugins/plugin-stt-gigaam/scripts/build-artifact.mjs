import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(".");
const dist = resolve(root, "dist");
await mkdir(dist, { recursive: true });
for (const file of ["package.json", "README.md"]) {
  await writeFile(resolve(dist, file), await readFile(resolve(root, file), "utf8"));
}
const pkgPath = resolve(dist, "package.json");
const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
pkg.paperclipPlugin = {
  manifest: "./manifest.js",
  worker: "./worker.js",
};
await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

