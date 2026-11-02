import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(".");
const dist = resolve(root, "dist");
await mkdir(dist, { recursive: true });
await writeFile(resolve(dist, "README.md"), await readFile(resolve(root, "README.md"), "utf8"));
await writeFile(resolve(dist, "package.json"), await readFile(resolve(root, "package.json"), "utf8"));
await Promise.all(["manifest.js", "worker.js"].map((file) => access(resolve(dist, file))));
const pkgPath = resolve(dist, "package.json");
const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
pkg.paperclipPlugin = {
  manifest: "./manifest.js",
  worker: "./worker.js",
};
await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

