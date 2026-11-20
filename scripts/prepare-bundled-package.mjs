#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function materializePublishManifest(pkg) {
  const publishConfig = pkg.publishConfig ?? {};
  const publishManifest = { ...pkg };

  for (const key of ["main", "types", "exports", "bin"]) {
    if (publishConfig[key] !== undefined) publishManifest[key] = publishConfig[key];
  }

  for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    if (!publishManifest[section]) continue;
    publishManifest[section] = Object.fromEntries(
      Object.entries(publishManifest[section]).map(([name, specifier]) => {
        if (typeof specifier !== "string" || !specifier.startsWith("workspace:")) return [name, specifier];
        const range = specifier.slice("workspace:".length);
        const prefix = range === "^" || range === "~" ? range : "";
        return [name, `${prefix}${pkg.version}`];
      }),
    );
  }

  delete publishManifest.publishConfig;
  return publishManifest;
}

export function createBundledInstallManifest(publishManifest, bundledDependencies) {
  const bundledDependencyNames = new Set(bundledDependencies);
  const installManifest = structuredClone(publishManifest);

  delete installManifest.devDependencies;

  for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    if (!installManifest[section]) continue;
    installManifest[section] = Object.fromEntries(
      Object.entries(installManifest[section]).filter(([name]) => bundledDependencyNames.has(name)),
    );
    if (Object.keys(installManifest[section]).length === 0) delete installManifest[section];
  }

  return installManifest;
}

function patchedDependencyPackageName(specifier) {
  const versionSeparator = specifier.lastIndexOf("@");
  const packageNameEnd = specifier.startsWith("@") ? specifier.indexOf("/") : 0;
  if (packageNameEnd < 0) return specifier;
  return versionSeparator > packageNameEnd ? specifier.slice(0, versionSeparator) : specifier;
}

export function selectBundledDependencyPatches(
  destinationDir,
  bundledDependencies,
  patchedDependencies,
) {
  const patchesByPackageName = new Map();
  for (const [specifier, patchPath] of Object.entries(patchedDependencies)) {
    const packageName = patchedDependencyPackageName(specifier);
    const packagePatches = patchesByPackageName.get(packageName) ?? new Map();
    packagePatches.set(specifier, patchPath);
    patchesByPackageName.set(packageName, packagePatches);
  }

  const selectedPatches = [];
  for (const packageName of new Set(bundledDependencies)) {
    const packagePatches = patchesByPackageName.get(packageName);
    if (!packagePatches) continue;

    const installedManifestPath = resolve(
      destinationDir,
      "node_modules",
      packageName,
      "package.json",
    );
    let installedManifest;
    try {
      installedManifest = JSON.parse(readFileSync(installedManifestPath, "utf8"));
    } catch (cause) {
      throw new Error(
        `Cannot select a patch for bundled dependency ${packageName}: failed to read ${installedManifestPath}`,
        { cause },
      );
    }

    if (
      installedManifest.name !== packageName ||
      typeof installedManifest.version !== "string" ||
      installedManifest.version.length === 0
    ) {
      throw new Error(
        `Cannot select a patch for bundled dependency ${packageName}: installed package manifest must declare the expected name and a version`,
      );
    }

    const installedSpecifier = `${packageName}@${installedManifest.version}`;
    const patchPath = packagePatches.get(installedSpecifier);
    if (patchPath === undefined) {
      const configuredSpecifiers = [...packagePatches.keys()].sort().join(", ");
      throw new Error(
        `Cannot select a patch for bundled dependency ${packageName}: installed ${installedSpecifier}, but configured patches are ${configuredSpecifiers}`,
      );
    }
    if (typeof patchPath !== "string" || patchPath.length === 0) {
      throw new Error(`Patch path for ${installedSpecifier} must be a non-empty string`);
    }
    selectedPatches.push({ packageName, specifier: installedSpecifier, patchPath });
  }

  return selectedPatches;
}

export function applyBundledDependencyPatches(destinationDir, bundledDependencies, sourceRoot = repoRoot) {
  const rootPackage = JSON.parse(readFileSync(resolve(sourceRoot, "package.json"), "utf8"));
  const patchedDependencies = rootPackage.pnpm?.patchedDependencies ?? {};

  for (const { packageName, patchPath } of selectBundledDependencyPatches(
    destinationDir,
    bundledDependencies,
    patchedDependencies,
  )) {
    execFileSync(
      "patch",
      ["-p1", "--forward", "-d", resolve(destinationDir, "node_modules", packageName)],
      {
        input: readFileSync(resolve(sourceRoot, patchPath)),
        stdio: ["pipe", "inherit", "inherit"],
      },
    );
  }
}

function isContained(parent, child) {
  const pathFromParent = relative(parent, child);
  return pathFromParent === "" || (pathFromParent !== ".." && !pathFromParent.startsWith(`..${sep}`) && !isAbsolute(pathFromParent));
}

function resolveExistingAncestor(path) {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  return resolve(resolveExistingAncestor(parent), basename(path));
}

function validateSourceTree(path, root) {
  const actual = realpathSync(path);
  if (!isContained(root, actual)) {
    throw new Error(`Cannot stage bundled package: source path resolves outside source directory: ${path}`);
  }
  if (lstatSync(path).isDirectory()) {
    for (const name of readdirSync(path)) validateSourceTree(resolve(path, name), root);
  }
}

function validateBundleStaging(sourceDir, destinationDir, entries) {
  const sourcePath = resolve(sourceDir);
  const destinationPath = resolve(destinationDir);
  if (isContained(sourcePath, destinationPath) || isContained(destinationPath, sourcePath)) {
    throw new Error("Cannot stage bundled package: source and destination directories overlap");
  }

  const realSourcePath = realpathSync(sourcePath);
  const realDestinationPath = resolveExistingAncestor(destinationPath);
  if (
    realDestinationPath &&
    (isContained(realSourcePath, realDestinationPath) || isContained(realDestinationPath, realSourcePath))
  ) {
    throw new Error("Cannot stage bundled package: source and destination directories overlap after resolving symlinks");
  }

  for (const entry of entries) {
    if (typeof entry !== "string" || entry.length === 0 || isAbsolute(entry) || /[*?[\]{}]/.test(entry)) {
      throw new Error(`Cannot stage bundled package: unsupported package.files path ${JSON.stringify(entry)}`);
    }
    const sourceEntry = resolve(sourcePath, entry);
    const destinationEntry = resolve(destinationPath, entry);
    if (!isContained(sourcePath, sourceEntry) || !isContained(destinationPath, destinationEntry)) {
      throw new Error(`Cannot stage bundled package: package.files path escapes its root: ${entry}`);
    }
    let realSourceEntry;
    try {
      realSourceEntry = realpathSync(sourceEntry);
    } catch (cause) {
      throw new Error(`Cannot stage bundled package: package.files entry does not exist: ${entry}`, { cause });
    }
    if (!isContained(realSourcePath, realSourceEntry)) {
      throw new Error(`Cannot stage bundled package: package.files entry resolves outside source directory: ${entry}`);
    }
    validateSourceTree(sourceEntry, realSourcePath);
  }
}

export function prepareBundledPackage(sourceDir, destinationDir, { sourceRoot = repoRoot } = {}) {
  const sourcePackagePath = resolve(sourceDir, "package.json");
  const sourcePackage = JSON.parse(readFileSync(sourcePackagePath, "utf8"));
  const bundledDependencies = sourcePackage.bundleDependencies ?? sourcePackage.bundledDependencies ?? [];

  if (bundledDependencies.length === 0) {
    throw new Error(`${sourcePackage.name} does not declare bundled dependencies`);
  }

  const files = sourcePackage.files ?? [];
  const ancillaryEntries = ["README.md", "LICENSE", "LICENSE.md"].filter((entry) => {
    try {
      lstatSync(resolve(sourceDir, entry));
      return true;
    } catch (cause) {
      if (cause.code === "ENOENT") return false;
      throw cause;
    }
  });
  validateBundleStaging(sourceDir, destinationDir, [...files, ...ancillaryEntries]);
  rmSync(destinationDir, { recursive: true, force: true });
  mkdirSync(destinationDir, { recursive: true });
  for (const entry of files) {
    cpSync(resolve(sourceDir, entry), resolve(destinationDir, entry), { recursive: true });
  }
  for (const entry of ["README.md", "LICENSE", "LICENSE.md"]) {
    const sourcePath = resolve(sourceDir, entry);
    if (existsSync(sourcePath)) cpSync(sourcePath, resolve(destinationDir, entry));
  }

  const deployedPackagePath = resolve(destinationDir, "package.json");
  const publishManifest = materializePublishManifest(sourcePackage);
  const installManifest = createBundledInstallManifest(publishManifest, bundledDependencies);
  writeFileSync(deployedPackagePath, `${JSON.stringify(installManifest, null, 2)}\n`);

  execFileSync(
    "npm",
    ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: destinationDir, stdio: "inherit" },
  );
  writeFileSync(deployedPackagePath, `${JSON.stringify(publishManifest, null, 2)}\n`);
  applyBundledDependencyPatches(destinationDir, bundledDependencies, sourceRoot);

  if (bundledDependencies.includes("acpx")) {
    const acpxPackage = JSON.parse(
      readFileSync(resolve(destinationDir, "node_modules/acpx/package.json"), "utf8"),
    );
    const expectedPatchMarker = {
      "0.12.0": "onAgentStderr",
      "0.13.1": "spawnEnvironment",
    }[acpxPackage.version];
    const acpxRuntime = readFileSync(
      resolve(destinationDir, "node_modules/acpx/dist/runtime.js"),
      "utf8",
    );
    if (!expectedPatchMarker || !acpxRuntime.includes(expectedPatchMarker)) {
      throw new Error(
        `staged acpx@${acpxPackage.version} runtime is missing the repository patch`,
      );
    }
  }

  if (bundledDependencies.includes("embedded-postgres")) {
    const embeddedPostgresSource = readFileSync(
      resolve(destinationDir, "node_modules/embedded-postgres/dist/index.js"),
      "utf8",
    );
    if (
      !embeddedPostgresSource.includes("const LC_MESSAGES_LOCALE = 'C';") ||
      !embeddedPostgresSource.includes("globalThis.process.env")
    ) {
      throw new Error("staged embedded-postgres runtime is missing the repository patch");
    }

    const embeddedPostgresPackage = JSON.parse(
      readFileSync(resolve(destinationDir, "node_modules/embedded-postgres/package.json"), "utf8"),
    );
    const stagedPackage = JSON.parse(readFileSync(deployedPackagePath, "utf8"));
    stagedPackage.optionalDependencies = {
      ...(stagedPackage.optionalDependencies ?? {}),
      ...(embeddedPostgresPackage.optionalDependencies ?? {}),
    };
    writeFileSync(deployedPackagePath, `${JSON.stringify(stagedPackage, null, 2)}\n`);
    rmSync(resolve(destinationDir, "node_modules/@embedded-postgres"), { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [sourceDir, destinationDir] = process.argv.slice(2);
  if (!sourceDir || !destinationDir) {
    console.error("Usage: prepare-bundled-package.mjs <source-dir> <destination-dir>");
    process.exit(1);
  }
  prepareBundledPackage(resolve(sourceDir), resolve(destinationDir));
}
