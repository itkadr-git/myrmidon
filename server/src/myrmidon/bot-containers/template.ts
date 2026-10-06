// server/src/myrmidon/bot-containers/template.ts
//
// Pure helpers for the docker-driver's fixed container template
// (containers-plan-senior-2026-09-28.md §1.4: "fleetd is not a Docker API proxy, it
// is a service with a fixed template"). Everything here is deterministic and does no
// I/O, so the driver's tests cover it directly without a Docker socket.
// This is also the enforcement boundary: a BotContainerSpec coming from an agent's
// adapterConfig (index.ts) cannot smuggle in an arbitrary image, bind mount or
// network, and a compiled profile file cannot address anything outside its own
// volume or the driver's reserved bookkeeping paths — only what these functions
// accept ever reaches the Docker API.

import { isScopeInstanceDirName } from "@paperclipai/shared";
import type { BotContainerSpec, BotExtraMount } from "./driver.js";
import type { CompiledProfileFile } from "./types.js";

// DNS label rules (RFC 1123) plus the same character set as the tar/exec paths
// below assume: no ".", no "/", nothing that could escape MYRMIDON_BOT_VOLUME_ROOT.
export const BOT_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export class BotContainerTemplateError extends Error {}

export function validateBotKey(botKey: string): void {
  if (!BOT_KEY_PATTERN.test(botKey)) {
    throw new BotContainerTemplateError(`invalid bot key "${botKey}": must match ${BOT_KEY_PATTERN}`);
  }
}

export function containerNameFor(botKey: string): string {
  validateBotKey(botKey);
  return `myrmidon-bot-${botKey}`;
}

/** Name of the short-lived helper container the driver uses to prepare a bot's
 *  volumes and to lay its profile down. The "." separator cannot occur in a bot
 *  key (BOT_KEY_PATTERN), so this can never collide with another bot's own
 *  container name ("myrmidon-bot-<key>-helper" could: bot key "<key>-helper"). */
export function helperContainerNameFor(botKey: string): string {
  return `${containerNameFor(botKey)}.helper`;
}

/** Name a replacement container is created under during a template-drift
 *  recreate, before it is renamed over the old one. Same "." reasoning as above. */
export function replacementContainerNameFor(botKey: string): string {
  return `${containerNameFor(botKey)}.next`;
}

/** MYRMIDON_BOT_IMAGE_ALLOWLIST: comma-separated globs. `*` matches any run of
 *  characters other than "/", so a pattern never crosses a path segment. */
export function parseImageAllowlist(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** MYRMIDON_BOT_MOUNT_SOURCES: comma-separated absolute host directories a
 *  card's `container.extraMounts` may name as a `source`. Instance-wide and
 *  operator-controlled: a card can only pick from this list, never invent a
 *  path. An entry that is not a plain absolute directory (see
 *  `unsafeAbsolutePathReason`) can never match a mount and is dropped. */
export const BOT_MOUNT_SOURCES_ENV = "MYRMIDON_BOT_MOUNT_SOURCES";

export function parseMountSourceAllowlist(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

// ---------------------------------------------------------------------------
// BUILD-OFFLOAD C: the dev-variant build server (devbuild)
// ---------------------------------------------------------------------------

/** Board env: hostname of the build server a dev-variant bot runs its builds
 *  on. Unset/blank — the devbuild wiring is off and nothing is added to any
 *  container (the operator keeps the address itself off the board's hosts, part
 *  D of BUILD-OFFLOAD sets it on the board host). */
export const DEVBUILD_HOST_ENV = "MYRMIDON_DEVBUILD_HOST";
/** Board env: ssh user on the build server. Default `devbuild`. */
export const DEVBUILD_USER_ENV = "MYRMIDON_DEVBUILD_USER";
export const DEFAULT_DEVBUILD_USER = "devbuild";
/** Board env: base directory of build workspaces on the build server.
 *  Default `/srv/devbuild`. */
export const DEVBUILD_BASE_ENV = "MYRMIDON_DEVBUILD_BASE";
export const DEFAULT_DEVBUILD_BASE = "/srv/devbuild";

/** Parsed MYRMIDON_DEVBUILD_* settings. `host: null` means "the devbuild
 *  wiring is off": no DEVBUILD_* env, no key mount, for any bot. Whitespace-only
 *  values count as unset (the same trim rule the other comma lists use). */
export interface DevbuildSettings {
  host: string | null;
  /** Default DEFAULT_DEVBUILD_USER when the setting is unset. */
  user: string;
  /** Default DEFAULT_DEVBUILD_BASE when the setting is unset. */
  base: string;
}

/** Directory-name suffix the operator's MYRMIDON_BOT_MOUNT_SOURCES entry for
 *  the devbuild ssh key must end with (`…/devbuild-ssh`). Only the suffix is
 *  fixed here: the parent directory is the operator's choice, and the address
 *  of the build server itself never enters the code. */
export const DEVBUILD_KEY_MOUNT_SOURCE_SUFFIX = "devbuild-ssh";

export function parseDevbuildSettings(env: NodeJS.ProcessEnv): DevbuildSettings {
  const host = env[DEVBUILD_HOST_ENV]?.trim() || null;
  const user = env[DEVBUILD_USER_ENV]?.trim() || DEFAULT_DEVBUILD_USER;
  const base = env[DEVBUILD_BASE_ENV]?.trim() || DEFAULT_DEVBUILD_BASE;
  return { host, user, base };
}

/** True for the development variant of the bot runtime image
 *  (`ghcr.io/itkadr-git/myrmidon-hermes-dev`). The image carries the
 *  `io.github.itkadr-git.myrmidon.variant="dev"` label, but the driver never
 *  inspects image labels at create time (it only checks the runtime-contract
 *  label), so the variant is recognized by the image reference itself: the
 *  repository name must end in `myrmidon-hermes-dev`, with any registry prefix
 *  and any tag/digest. This is deliberately conservative — a similarly named
 *  image in another namespace gets the devbuild wiring only if its repo path
 *  ends with the exact segment, and an operator who allows such an image in
 *  MYRMIDON_BOT_IMAGE_ALLOWLIST has named it explicitly. */
export function isDevBuildImage(image: string): boolean {
  // Strip a tag or digest ("name:tag", "name@sha256:…"), keeping any registry
  // and namespace prefixes; then compare the last path segment.
  const name = image.split("@")[0]!.replace(/:[^:/@]+$/, "");
  const segments = name.split("/");
  return segments[segments.length - 1] === "myrmidon-hermes-dev";
}

/** The container env entries a dev-variant bot gets when the devbuild wiring is
 *  on (DEVBUILD_HOST set). The values are internal hostnames and paths, not
 *  secrets: they may sit in the container env (which `docker inspect` shows),
 *  unlike the ssh key, which travels only as the read-only file mount at
 *  DEVBUILD_SSH_CONTAINER_PATH. Null when the wiring is off — the caller adds
 *  nothing. The card's profile .env is a separate file (hermes/.env) and is not
 *  touched by this. */
export function devbuildContainerEnv(settings: DevbuildSettings): Record<string, string> | null {
  if (settings.host === null) return null;
  return {
    DEVBUILD_HOST: settings.host,
    DEVBUILD_USER: settings.user,
    DEVBUILD_BASE: settings.base,
  };
}

/** The read-only key mount a dev-variant bot gets when the devbuild wiring is
 *  on, or null. The source must come from MYRMIDON_BOT_MOUNT_SOURCES — the
 *  operator names the key directory there like any other extra mount source —
 *  so a card can never invent a host path. The container path
 *  (/opt/devbuild-ssh) is reserved in RESERVED_CONTAINER_PATHS, so a card's own
 *  extraMounts can never take it over. */
export function devbuildKeyMount(settings: DevbuildSettings, mountSources: readonly string[]): BotExtraMount | null {
  if (settings.host === null) return null;
  const source = mountSources.find(
    (candidate) => unsafeAbsolutePathReason(candidate) === null && candidate.endsWith(DEVBUILD_KEY_MOUNT_SOURCE_SUFFIX),
  );
  if (!source) return null;
  return { source, containerPath: DEVBUILD_SSH_CONTAINER_PATH, readOnly: true };
}

function escapeRegExpLiteral(chunk: string): string {
  return chunk.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegExp(glob: string): RegExp {
  const pattern = glob
    .split("*")
    .map((chunk) => escapeRegExpLiteral(chunk))
    .join("[^/]*");
  return new RegExp(`^${pattern}$`);
}

export function isImageAllowed(image: string, allowlist: readonly string[]): boolean {
  return allowlist.some((glob) => globToRegExp(glob).test(image));
}

export interface BotVolumeMount {
  /** Path segment under MYRMIDON_BOT_VOLUME_ROOT/<botKey>, e.g. "hermes". Also the
   *  required first path segment of a CompiledProfileFile.path that belongs here. */
  hostSuffix: "hermes" | "workspace" | "scratch";
  /** Absolute mount point inside the container. */
  containerPath: string;
}

/**
 * myrmidon(BOT-DISK-D): the ONE bind mount of a bot container. link(2) refuses to
 * cross a mount point (EXDEV) even between two binds of the same host filesystem,
 * so with `hermes`, `workspace` and `scratch` as three binds (and a pnpm store on
 * a fourth) pnpm silently copied every package into every clone. The bot's whole
 * writable tree, `<MYRMIDON_BOT_VOLUME_ROOT>/<botKey>`, is now ONE bind at
 * {@link BOT_ROOT_MOUNT}; `/data/hermes`, `/workspace` and `/scratch` are links
 * made by the image (docker/bot-runtime/Dockerfile) that resolve into it, so a
 * hard link works between any two of them and the pnpm store.
 */
export const BOT_ROOT_MOUNT = "/bot";

/** Where a LEGACY-layout (contract "1") image mounts its hermes volume, and the
 *  root {@link botRealRootFromBinds} answers for such a container: hermes is
 *  mounted directly at /data/hermes, so `${root}/hermes` resolves there. */
const HERMES_MOUNT_PATH = "/data/hermes";
export const LEGACY_BOT_REAL_ROOT = "/data";

/**
 * myrmidon(BOT-DISK-F): the mount of a member of a SHARED isolation-scope
 * instance. Instead of `<volumeRoot>/<botKey>:/bot` the container gets ONE bind,
 * `<scopeRoot>/<instance>:/bot-scope`: the instance directory holds one pnpm
 * store ({@link BOT_SCOPE_STORE_DIR}) and a subdirectory per member bot
 * (`<botKey>/{hermes,workspace,scratch}`), so a hard link works within a bot and
 * between the bots of the instance. The image's `/data/hermes`, `/workspace` and
 * `/scratch` links point at `/bot`, which does not exist for a member, so a
 * tmpfs over `/data` carries links made at start from the one variable
 * {@link BOT_SCOPE_SUBDIR_ENV} (docker/bot-runtime/entrypoint.sh). The bot sees
 * only its own instance's directory: a second instance is a different directory
 * and never mounted.
 */
export const BOT_SCOPE_MOUNT = "/bot-scope";
export const BOT_SCOPE_STORE_DIR = `${BOT_SCOPE_MOUNT}/.pnpm-store`;
/**
 * myrmidon(1.6.5 BOT-DISK-G): the shared git object store of a scope instance,
 * written to every member's profile as `MYRMIDON_GIT_LOCAL_MIRROR`. One bare
 * mirror per repository lives here (`<dir>/<owner>/<repo>.git`), made by the
 * image's git wrapper on the first clone inside the instance, and every later
 * clone of the same repository on ANY member borrows its objects through
 * `--reference-if-able` — so a task clone carries only its working tree. The
 * store is inside the instance's single mount (like the pnpm store above), it
 * lives beside it and is never a draft, so no clone lifecycle ever removes it;
 * the wrapper keeps its gc from pruning objects any clone may still borrow.
 */
export const BOT_SCOPE_GIT_OBJECTS_DIR = `${BOT_SCOPE_MOUNT}/.git-objects`;
/** The per-bot default of the same store when no scope instance owns one (entrypoint + wrapper agree on this path). */
export const BOT_GIT_OBJECTS_DIR = "/data/hermes/.myrmidon/git-objects";
export const BOT_SCOPE_SUBDIR_ENV = "MYRMIDON_BOT_SCOPE_SUBDIR";
/** The tmpfs over `/data` of a member: only links, owned by the bot's uid. */
export const BOT_SCOPE_DATA_TMPFS = "uid=10001,gid=10001,mode=0755,size=1m";
/** Where the prepare helper of a member sees the instance directory (to hand it to the bot's uid). */
export const BOT_SCOPE_HELPER_MOUNT = "/scope";
/** Image label declaring the runtime can run as a member (entrypoint links, WORKDIR-independent start). */
export const BOT_RUNTIME_SCOPE_LABEL = "myrmidon.bot-runtime.scope";

/** A member's place: the instance directory name under the shared root. */
export interface BotScopeMount {
  scopeRoot: string;
  /** `<kind>-<id>`, see `scopeInstanceDirName` in @paperclipai/shared. */
  dirName: string;
}

function assertScopeMount(scope: BotScopeMount): void {
  const reason = unsafeAbsolutePathReason(scope.scopeRoot);
  if (reason) throw new BotContainerTemplateError(`shared scope root ${JSON.stringify(scope.scopeRoot)} ${reason}`);
  if (!isScopeInstanceDirName(scope.dirName)) {
    throw new BotContainerTemplateError(`invalid scope instance directory name ${JSON.stringify(scope.dirName)}`);
  }
}

/** Where the compiled profile, the applied-state marker and the clone-hygiene
 *  report live, at their real paths inside {@link BOT_ROOT_MOUNT}. */
export const BOT_HERMES_REAL_PATH = `${BOT_ROOT_MOUNT}/hermes`;

/** The three directories of a bot's tree, each a path inside the single mount
 *  that the image also exposes as `containerPath`-style links
 *  (`/data/hermes`, `/workspace`, `/scratch`). */
export const BOT_VOLUME_MOUNTS: readonly BotVolumeMount[] = [
  { hostSuffix: "hermes", containerPath: "/data/hermes" },
  { hostSuffix: "workspace", containerPath: "/workspace" },
  { hostSuffix: "scratch", containerPath: "/scratch" },
];

/**
 * The three narrow binds of a HELPER container (prepare-volumes, apply-profile).
 * A helper only chowns and renames files and never needs a hard link, so it keeps
 * one bind per directory; only the bot container itself gets the single mount
 * ({@link buildBinds}). Same host directories either way.
 */
export function buildHelperBinds(
  volumeRoot: string,
  botKey: string,
  scope?: BotScopeMount,
  /** The prepare helper of a member also binds the instance directory itself. */
  withInstanceDir = false,
): string[] {
  validateBotKey(botKey);
  if (scope) {
    // myrmidon(BOT-ROOT-TRAVERSE): a shared member has no separate bot root to
    // normalize — its tree root IS the instance directory, already bound read-write
    // at the helper's /scope and handed to uid 10001 by the prepare script itself.
    assertScopeMount(scope);
    const base = `${scope.scopeRoot}/${scope.dirName}/${botKey}`;
    const binds = BOT_VOLUME_MOUNTS.map((mount) => `${base}/${mount.hostSuffix}:${mount.containerPath}`);
    if (withInstanceDir) binds.push(`${scope.scopeRoot}/${scope.dirName}:${BOT_SCOPE_HELPER_MOUNT}`);
    return binds;
  }
  const binds = BOT_VOLUME_MOUNTS.map((mount) => `${volumeRoot}/${botKey}/${mount.hostSuffix}:${mount.containerPath}`);
  if (withInstanceDir) {
    // myrmidon(BOT-ROOT-TRAVERSE): the isolated bot's whole directory (the one bind
    // the bot container gets at BOT_ROOT_MOUNT) must be enterable by uid 10001, but
    // the three narrow binds stop below it, so the helper never sees the root. The
    // prepare helper gets the root itself, as the SAME bind string the bot container
    // carries (`<volumeRoot>/<botKey>:/bot`, rw — chmod over a read-only bind is
    // EROFS): the script runs one non-recursive chmod on the mount point, without
    // ever listing or writing into the tree.
    binds.push(`${volumeRoot}/${botKey}:${BOT_ROOT_MOUNT}`);
  }
  return binds;
}

/**
 * The bot's real root inside its container, from the binds the container was
 * created with: the parent directory of `hermes` under which
 * `${root}/hermes/.myrmidon/...` is readable. A single-layout bot has its whole
 * tree at {@link BOT_ROOT_MOUNT}; a member of a shared scope instance at
 * `${BOT_SCOPE_MOUNT}/<botKey>`; a LEGACY-layout bot (contract "1", the three
 * separate binds) has hermes mounted directly at `/data/hermes`, so its root
 * is `/data`. The answer keys off the container's own binds — never off the
 * board's current template — because the marker and the clone report live where
 * the running container's image reads them.
 */
export function botRealRootFromBinds(binds: readonly string[] | undefined, botKey: string): string {
  const list = binds ?? [];
  if (list.some((bind) => bind.endsWith(`:${BOT_SCOPE_MOUNT}`))) return `${BOT_SCOPE_MOUNT}/${botKey}`;
  if (list.some((bind) => bind.endsWith(`:${HERMES_MOUNT_PATH}`))) return LEGACY_BOT_REAL_ROOT;
  return BOT_ROOT_MOUNT;
}

/** The shared scope instance directory name a container's binds name, or null for an isolated one. */
export function scopeDirNameFromBinds(binds: readonly string[] | undefined, scopeRoot: string): string | null {
  const prefix = `${scopeRoot}/`;
  for (const bind of binds ?? []) {
    if (bind.startsWith(prefix) && bind.endsWith(`:${BOT_SCOPE_MOUNT}`)) {
      return bind.slice(prefix.length, bind.length - `:${BOT_SCOPE_MOUNT}`.length);
    }
  }
  return null;
}

/** The fixed bind list for a bot, plus the extra read-only mounts its card asked
 *  for, plus the shared package cache when the instance configures one
 *  (1.6.1-BOT-DISK-B). Callers supply a botKey and (optionally) mount entries whose `source`
 *  already comes from the instance allowlist — never a raw path — so a card
 *  cannot smuggle in an arbitrary bind. A mount whose source is not in
 *  `MYRMIDON_BOT_MOUNT_SOURCES`, or whose container path would take over one of
 *  the driver's own mount points, throws before anything reaches the Docker API.
 *  The package cache binds are the only writable extra binds; their host
 *  subdirectories and container paths are fixed here (PACKAGE_CACHE_MOUNTS)
 *  and mirrored by dockergate, which accepts them only under its own
 *  `packageCacheRoot` (tools/dockergate/internal/policy/create.go).
 *  The driver's own devbuild key mount (BUILD-OFFLOAD C) rides `driverMount`:
 *  its container path is exactly the reserved DEVBUILD_SSH_CONTAINER_PATH (so it
 *  cannot go through validateExtraMounts, which rejects reserved paths for card
 *  mounts on purpose), but its source is held to the same
 *  MYRMIDON_BOT_MOUNT_SOURCES check as any card mount.
 *  `volumeLayout` (default "single") is the bind layout the bot's image contract
 *  pins — "legacy" puts the three separate binds first, "single" its one
 *  directory at {@link BOT_ROOT_MOUNT}; everything after them (extras, driver
 *  mount, cache) is identical under both (template.ts botVolumeLayout). A shared
 *  `scope` is only ever single layout. */
export function buildBinds(
  volumeRoot: string,
  botKey: string,
  extra: {
    mounts?: readonly BotExtraMount[];
    allowedSources?: readonly string[];
    sharedPackageCachePath?: string;
    /** myrmidon(1.6.2-BOT-DISK-C): also bind `<cache>/git` read-only at
     *  `/cache/git` (the board's git mirrors). Ignored without a cache path. */
    gitMirror?: boolean;
    /** myrmidon(1.6.1-BUILD-OFFLOAD C): a mount the DRIVER itself introduces
     *  (the devbuild ssh key), not the bot card. Validated against the same
     *  source allowlist and reserved-path rules, appended after extra mounts. */
    driverMount?: BotExtraMount | null;
    /** myrmidon(BOT-DISK-F): a member of a shared scope instance binds the instance directory instead of its own. */
    scope?: BotScopeMount;
    /** The bind layout the image's runtime contract declares (legacy = three binds, single = one /bot bind). */
    volumeLayout?: BotVolumeLayout;
  } = {},
): string[] {
  validateBotKey(botKey);
  const mounts = extra.mounts ?? [];
  validateExtraMounts(mounts, extra.allowedSources ?? []);
  const driverBind = extra.driverMount ? [validateDriverMount(extra.driverMount, extra.allowedSources ?? [])] : [];
  if (extra.scope) assertScopeMount(extra.scope);
  const legacy = extra.volumeLayout === "legacy" && !extra.scope;
  const binds = [
    legacy
      ? BOT_VOLUME_MOUNTS.map((mount) => `${volumeRoot}/${botKey}/${mount.hostSuffix}:${mount.containerPath}`)
      : [extra.scope ? `${extra.scope.scopeRoot}/${extra.scope.dirName}:${BOT_SCOPE_MOUNT}` : `${volumeRoot}/${botKey}:${BOT_ROOT_MOUNT}`],
    ...mounts.map((mount) => `${mount.source}:${mount.containerPath}:ro`),
    ...driverBind,
  ].flat();
  const cache = extra.sharedPackageCachePath;
  if (cache) {
    const reason = unsafeAbsolutePathReason(cache);
    if (reason) {
      throw new BotContainerTemplateError(`shared package cache path ${JSON.stringify(cache)} ${reason}`);
    }
    for (const [index, mount] of mounts.entries()) {
      if (mount.containerPath === PACKAGE_CACHE_CONTAINER_ROOT || mount.containerPath.startsWith(`${PACKAGE_CACHE_CONTAINER_ROOT}/`)) {
        throw new BotContainerTemplateError(
          `extra mount #${index + 1} path ${JSON.stringify(mount.containerPath)} is reserved for the shared package cache`,
        );
      }
    }
    for (const mount of PACKAGE_CACHE_MOUNTS) {
      binds.push(`${cache}/${mount.hostSubdir}:${mount.containerPath}:rw`);
    }
    if (extra.gitMirror) {
      binds.push(`${cache}/${GIT_MIRROR_MOUNT.hostSubdir}:${GIT_MIRROR_MOUNT.containerPath}:ro`);
    }
  }
  return binds;
}

/**
 * myrmidon(1.6.2-BOT-DISK-C): the board's bare git mirrors, one per
 * `owner/repo`, at `<cache>/git/<owner>/<repo>.git` on the host. Bots mount the
 * directory READ-ONLY: only the board writes it (git-mirror.ts), so no bot can
 * rewrite or delete an object another bot's clone borrows through its
 * alternates file — git does not re-hash objects it reads from an alternate,
 * so a writable mirror would let one bot change what another checks out. The
 * image's git wrapper (docker/bot-runtime/git-reference) adds
 * `--reference-if-able /cache/git/<owner>/<repo>.git` to a `git clone` of a
 * mirrored GitHub repository. Mirrored by dockergate
 * (`PackageCacheReadOnlyMounts` in tools/dockergate/internal/policy/create.go).
 */
export const GIT_MIRROR_MOUNT = { hostSubdir: "git", containerPath: "/cache/git" } as const;

/**
 * myrmidon(BOT-DISK-D): where pnpm keeps its content-addressed store by default
 * (settings `pnpmStoreDir`; the image's `npm_config_store_dir` is the same
 * value). It is inside the bot's single mount, so every clone anywhere in the
 * bot's tree can hard-link into it. Never `/cache/pnpm`: that is a different
 * mount, and pnpm cannot hard-link across mounts.
 */
export const DEFAULT_PNPM_STORE_DIR = "/workspace/.pnpm-store";

/** The import method pnpm is told to use: `hardlink` only tries hard links (no
 *  reflink attempts). pnpm 9 still copies when the kernel refuses a link, so a
 *  broken layout is caught by the container's start-time self-check
 *  (docker/bot-runtime/entrypoint.sh), not by pnpm. */
export const DEFAULT_PNPM_IMPORT_METHOD = "hardlink";

/** Container roots a pnpm store may live under (all inside the single mount). */
export const PNPM_STORE_ROOTS: readonly string[] = ["/workspace", "/data", "/scratch", BOT_ROOT_MOUNT, BOT_SCOPE_MOUNT];

/** Where the shared package cache appears inside a bot container. Outside the
 *  three volumes and /tmp, so dockergate's reserved-target rule holds. */
export const PACKAGE_CACHE_CONTAINER_ROOT = "/cache";

export interface PackageCacheMount {
  /** Subdirectory of the configured cache path on the host. */
  hostSubdir: string;
  /** Absolute mount point inside the container. */
  containerPath: string;
  /** The variable that points the tool at the mount (written to hermes/.env). */
  envName: string;
}

/**
 * Shared package cache layout (1.6.1-BOT-DISK-B). The tools only use a mount
 * because the profile points them at it: the image's own defaults live under
 * $HOME (/data/hermes, the per-bot volume), so profile-compile.ts writes
 * {@link packageCacheEnv} into hermes/.env, which the gateway loads with
 * override. pip is absent on purpose: the image sets PIP_NO_CACHE_DIR, which
 * disables pip's cache whatever its value, and a dotenv file cannot unset it.
 * Mirrored by dockergate (`PackageCacheMounts` in tools/dockergate/internal/policy/create.go).
 */
export const PACKAGE_CACHE_MOUNTS: readonly PackageCacheMount[] = [
  // pnpm: a DOWNLOAD cache only (registry metadata), never the store (see DEFAULT_PNPM_STORE_DIR).
  { hostSubdir: "pnpm", containerPath: "/cache/pnpm", envName: "npm_config_cache_dir" },
  { hostSubdir: "go-mod", containerPath: "/cache/go-mod", envName: "GOMODCACHE" },
  { hostSubdir: "go-build", containerPath: "/cache/go-build", envName: "GOCACHE" },
  { hostSubdir: "gradle", containerPath: "/cache/gradle", envName: "GRADLE_USER_HOME" },
];

/**
 * The environment that points each tool at its shared cache mount, plus the pnpm
 * store variables.
 *
 * myrmidon(BOT-DISK-D): pnpm links a project's node_modules to its store with hard
 * links, and link(2) refuses to cross a mount point. The store therefore lives
 * INSIDE the bot's single mount ({@link DEFAULT_PNPM_STORE_DIR}), `/cache/pnpm`
 * stays a download cache only, and the import method is `hardlink` by default (pnpm
 * does not report a refused link, it copies: the start-time self-check does). Both values come from the
 * bot-disk settings (`pnpmStoreDir`, `pnpmImportMethod`).
 */
export function packageCacheEnv(
  pnpm: { storeDir?: string; importMethod?: string } = {},
): Record<string, string> {
  const env = Object.fromEntries(PACKAGE_CACHE_MOUNTS.map((mount) => [mount.envName, mount.containerPath]));
  return { ...env, ...pnpmEnv(pnpm) };
}

/** Just the pnpm variables (see {@link packageCacheEnv}). */
export function pnpmEnv(pnpm: { storeDir?: string; importMethod?: string } = {}): Record<string, string> {
  return {
    npm_config_store_dir: pnpm.storeDir ?? DEFAULT_PNPM_STORE_DIR,
    npm_config_package_import_method: pnpm.importMethod ?? DEFAULT_PNPM_IMPORT_METHOD,
  };
}

/** The one extra bind the driver itself may add (the devbuild ssh key mount).
 *  Checked like a card mount for its source, but its container path is fixed to
 *  DEVBUILD_SSH_CONTAINER_PATH — the path a card's mount is refused at, so only
 *  the driver can ever occupy it. */
function validateDriverMount(mount: BotExtraMount, allowedSources: readonly string[]): string {
  if (mount.readOnly !== true) {
    throw new BotContainerTemplateError(`driver mount of ${JSON.stringify(mount.source)} must be read-only`);
  }
  if (mount.containerPath !== DEVBUILD_SSH_CONTAINER_PATH) {
    throw new BotContainerTemplateError(
      `driver mount of ${JSON.stringify(mount.source)} must use ${DEVBUILD_SSH_CONTAINER_PATH}`,
    );
  }
  const allowed = new Set(allowedSources.filter((source) => unsafeAbsolutePathReason(source) === null));
  if (!allowed.has(mount.source)) {
    throw new BotContainerTemplateError(
      `driver mount source ${JSON.stringify(mount.source)} is not listed in ${BOT_MOUNT_SOURCES_ENV}`,
    );
  }
  return `${mount.source}:${mount.containerPath}:ro`;
}

/** Mount points and paths the driver itself owns inside every bot container: an
 *  extra mount may neither take one of them over nor shadow a path under them
 *  (the profile lands in the three volumes, and `/tmp` is the image's tmpfs).
 *  DEVBUILD_SSH_CONTAINER_PATH is the driver's own devbuild key mount (BUILD-
 *  OFFLOAD C: the read-only ssh key of the build server a dev-variant bot uses);
 *  reserving it here means a card's `extraMounts` can never take it over. */
export const DEVBUILD_SSH_CONTAINER_PATH = "/opt/devbuild-ssh";
const RESERVED_CONTAINER_PATHS: readonly string[] = [
  ...BOT_VOLUME_MOUNTS.map((mount) => mount.containerPath),
  BOT_ROOT_MOUNT,
  BOT_SCOPE_MOUNT,
  BOT_SCOPE_HELPER_MOUNT,
  "/data",
  "/tmp",
  DEVBUILD_SSH_CONTAINER_PATH,
];

/** Why `value` is not usable as an absolute host directory or container mount
 *  point, or null when it is. Deliberately strict: no relative form, no "..",
 *  no empty segment, no trailing slash, no backslash or control character, and
 *  not the filesystem root — so two spellings of the same directory can never
 *  compare unequal. */
function unsafeAbsolutePathReason(value: string): string | null {
  if (!value.startsWith("/")) return "is not an absolute path";
  if (value.length === 1) return "is the filesystem root";
  if (hasControlCharacter(value)) return "contains a control character";
  if (value.includes("\\")) return "contains a backslash";
  if (value.includes("//")) return "has an empty path segment";
  if (value.endsWith("/")) return "has a trailing slash";
  for (const segment of value.split("/")) {
    if (segment === "." || segment === "..") return `has a "${segment}" path segment`;
  }
  return null;
}

/**
 * Throws unless every extra mount may be mounted into a bot container:
 *  - `source` is a plain absolute directory and is listed in
 *    `MYRMIDON_BOT_MOUNT_SOURCES` (exact match — no prefix rule, so a card
 *    cannot reach a sibling directory the operator did not name);
 *  - `containerPath` is a plain absolute path that is not one of the driver's
 *    own mount points (or a path under one) and is not used twice;
 *  - `readOnly` is true: a card's extra mount is never writable.
 * The check is the enforcement boundary, so it does not trust the card reader
 * (`agent-config.ts`) to have validated the list first.
 */
export function validateExtraMounts(mounts: readonly BotExtraMount[], allowedSources: readonly string[]): void {
  const allowed = new Set(allowedSources.filter((source) => unsafeAbsolutePathReason(source) === null));
  const taken = new Set<string>(RESERVED_CONTAINER_PATHS);
  for (const [index, mount] of mounts.entries()) {
    const where = `extra mount #${index + 1}`;
    const sourceReason = unsafeAbsolutePathReason(mount.source);
    if (sourceReason) {
      throw new BotContainerTemplateError(`${where} source ${JSON.stringify(mount.source)} ${sourceReason}`);
    }
    if (!allowed.has(mount.source)) {
      throw new BotContainerTemplateError(
        `${where} source ${JSON.stringify(mount.source)} is not listed in ${BOT_MOUNT_SOURCES_ENV}`,
      );
    }
    if (mount.readOnly !== true) {
      throw new BotContainerTemplateError(`${where} of ${JSON.stringify(mount.source)} must be read-only`);
    }
    const pathReason = unsafeAbsolutePathReason(mount.containerPath);
    if (pathReason) {
      throw new BotContainerTemplateError(`${where} path ${JSON.stringify(mount.containerPath)} ${pathReason}`);
    }
    const clashes = RESERVED_CONTAINER_PATHS.some(
      (reserved) => mount.containerPath === reserved || mount.containerPath.startsWith(`${reserved}/`),
    );
    if (clashes || taken.has(mount.containerPath)) {
      throw new BotContainerTemplateError(
        `${where} path ${JSON.stringify(mount.containerPath)} is reserved by the driver or used twice`,
      );
    }
    taken.add(mount.containerPath);
  }
}

/** `mount.containerPath` without its leading "/", e.g. "data/hermes". This is the
 *  path segment to use for anything addressed *inside* the container relative to
 *  its root (the apply script's paths) — never `mount.hostSuffix`, which only
 *  names the bind's source directory under MYRMIDON_BOT_VOLUME_ROOT and does not
 *  match the mount point for "hermes" (host suffix "hermes" mounts to
 *  "/data/hermes", not "/hermes"). */
export function mountRootSegment(mount: BotVolumeMount): string {
  return mount.containerPath.replace(/^\//, "");
}

/**
 * Directories (as profile paths) that the profile compiler owns outright: on
 * every apply their whole content is replaced by exactly what the new profile
 * carries under them — including nothing at all — instead of being merged file
 * by file. "hermes/skills-board" is the compiler's copy of the card's skills
 * (Hermes reads the whole directory through `skills.external_dirs`), so a skill
 * removed from the card must disappear from it; a per-file merge never removes
 * anything. The bot's own skills live elsewhere under hermes/ and are untouched.
 */
export const BOT_MANAGED_DIRS: readonly string[] = ["hermes/skills-board"];

/** True when a profile path is a managed directory itself or lies under one. */
export function isUnderManagedDir(profilePath: string): boolean {
  return BOT_MANAGED_DIRS.some((dir) => profilePath === dir || profilePath.startsWith(`${dir}/`));
}

/** Prefix of every path segment the driver reserves for its own bookkeeping at a
 *  mount root: the applied-state marker (".myrmidon/"), the per-apply staging
 *  (".myrmidon-next-<nonce>/"), the apply metadata (".myrmidon-apply-<nonce>/")
 *  and the set-aside copy of a replaced managed directory (".myrmidon-old-<nonce>/"). */
export const RESERVED_SEGMENT_PREFIX = ".myrmidon";

export const BOT_LABEL_KEYS = {
  bot: "myrmidon.bot",
  image: "myrmidon.image",
  /** Set on the driver's helper containers instead of `bot`, so they never show
   *  up as a bot in `list()`. */
  helper: "myrmidon.bot-helper",
} as const;

/**
 * Image label through which a bot runtime image declares the runtime contract
 * this driver relies on. Being present on the host and matching
 * MYRMIDON_BOT_IMAGE_ALLOWLIST is not enough: create/recreate refuse an image
 * that does not declare one of SUPPORTED_BOT_RUNTIME_CONTRACTS, before
 * anything is created (docker-driver.ts). An image that exists but was built
 * for another contract would otherwise only fail after the container is
 * created and started, and then crash-loop under its restart policy on every
 * pass.
 *
 * Both contracts say the same about the process:
 *  - the gateway runs as uid:gid 10001:10001 with HERMES_HOME=/data/hermes and
 *    /workspace as its working directory;
 *  - every secret the gateway needs, API_SERVER_KEY included, is read from
 *    $HERMES_HOME/.env (dotenv `KEY="value"` lines, read as data and never
 *    executed by a shell). The driver never puts a secret in the container's
 *    environment, where `docker inspect` shows it, so the image must not
 *    require one there;
 *  - it writes nothing outside its bot tree, /tmp (a tmpfs) and volumes
 *    the image declares itself: the driver runs it with a read-only root
 *    filesystem;
 *  - /bin/sh with find, mv (with -T), mkdir -p, rm, chmod, chown and dirname:
 *    the driver's helper containers run its scripts with the image's own shell.
 *
 * They differ in ONE thing, the volume layout the driver must mount (this is
 * the versioning the 1.6.5-rc.1 rollout defect was missing: the layout changed
 * under contract "1" without changing it, and the board recreated 1.6.4
 * containers with the new one-mount template — the old image then found its
 * $HERMES_HOME an empty anonymous volume and crash-looped on
 * "API_SERVER_KEY is required"):
 *
 * Contract "1" — the LEGACY layout ("legacy"): three separate binds,
 *    `<volumeRoot>/<botKey>/{hermes,workspace,scratch}` mounted at
 *    /data/hermes, /workspace and /scratch, owned by 10001, mode 0700. An
 *    image built for this contract resolves HERMES_HOME through the real
 *    mount, so the one-mount layout would leave it writing into an anonymous
 *    volume. Old release images (1.6.4) keep working under a newer board:
 *    their containers are recreated under the layout they were built for.
 * Contract "2" — the SINGLE-mount layout ("single", BOT-DISK-D): the bot's
 *    whole writable tree, `<volumeRoot>/<botKey>`, is ONE bind at
 *    {@link BOT_ROOT_MOUNT} (`/bot`); /data/hermes, /workspace and /scratch
 *    are links made by the image into it, so hard links (pnpm's node_modules
 *    into its store) work within the tree. A member of a shared isolation
 *    scope ({@link BOT_RUNTIME_SCOPE_LABEL}, BOT-DISK-F) is only ever single
 *    layout: it binds the instance directory at {@link BOT_SCOPE_MOUNT}.
 *
 * Transition rule: images built between the layout change and this versioning
 * carry contract "1" AND the scope label (BOT-DISK-F shipped with the single
 * mount): the scope label is the only thing that tells them apart from a
 * three-volume release image, so a contract "1" image that declares it is
 * handled as single layout. A contract "1" image without it gets the legacy
 * binds — the three host directories it mounts are the same ones /bot holds,
 * so even a BOT-DISK-D-era image boots under them (its /data links are
 * shadowed by the mounts), and a profile apply needs no /bot at all.
 */
export const BOT_RUNTIME_CONTRACT_LABEL = "myrmidon.bot-runtime.contract";
export const LEGACY_BOT_RUNTIME_CONTRACT = "1";
export const SINGLE_BOT_RUNTIME_CONTRACT = "2";
export const SUPPORTED_BOT_RUNTIME_CONTRACTS: readonly string[] = [LEGACY_BOT_RUNTIME_CONTRACT, SINGLE_BOT_RUNTIME_CONTRACT];

/** The volume layout an image's contract pins the driver to (see above). */
export type BotVolumeLayout = "legacy" | "single";

/** The contract an image declares, or a clear refusal. Never returns an
 *  unsupported value: an image without the label or with a contract this
 *  driver does not know is refused before anything is created. */
export function declaredBotRuntimeContract(image: string, labels: Record<string, string> | null | undefined): string {
  const declared = labels?.[BOT_RUNTIME_CONTRACT_LABEL];
  if (declared !== undefined && SUPPORTED_BOT_RUNTIME_CONTRACTS.includes(declared)) return declared;
  const wanted = SUPPORTED_BOT_RUNTIME_CONTRACTS.map((version) => `${BOT_RUNTIME_CONTRACT_LABEL}=${version}`).join(" or ");
  throw new BotContainerTemplateError(
    declared === undefined
      ? `image "${image}" does not declare the bot runtime contract (image label ${wanted}); ` +
          "nothing is created from an image not known to take API_SERVER_KEY from $HERMES_HOME/.env"
      : `image "${image}" declares bot runtime contract "${declared}", this driver supports only ${wanted}`,
  );
}

/** The volume layout the driver must mount for an image: contract "2" is the
 *  single mount; contract "1" is the legacy three-volume layout, except for
 *  images that also declare the scope label, which are BOT-DISK-D/F builds
 *  from before the layout was versioned and take the single mount (see the
 *  contract docstring). Throws on an image without a supported contract. */
export function botVolumeLayout(image: string, labels: Record<string, string> | null | undefined): BotVolumeLayout {
  if (declaredBotRuntimeContract(image, labels) === SINGLE_BOT_RUNTIME_CONTRACT) return "single";
  return labels?.[BOT_RUNTIME_SCOPE_LABEL] === "1" ? "single" : "legacy";
}

/** Throws unless the image labels (`Config.Labels` of `GET /images/{name}/json`,
 *  which Docker returns as null for an image without labels) declare a
 *  supported bot runtime contract. */
export function assertBotRuntimeContract(image: string, labels: Record<string, string> | null | undefined): void {
  declaredBotRuntimeContract(image, labels);
}

/**
 * Identification labels for a bot container. Deliberately carries no profile
 * hashes: Docker cannot change a container's labels after creation, so a hash
 * label would only ever mean "desired when the container was created", never
 * "applied" — and treating it as applied state is exactly what let a failed
 * first profile write look like a finished one. Applied state lives only in the
 * marker file writeProfile moves into place last (docker-driver.ts).
 *
 * The driver's own keys always win over anything in `spec.labels` — a caller
 * cannot use that field to spoof `myrmidon.bot` and hide a container from
 * `list()`'s orphan scan, nor tag one as a helper.
 */
export function buildLabels(spec: Pick<BotContainerSpec, "botKey" | "image" | "labels">): Record<string, string> {
  const labels: Record<string, string> = { ...spec.labels };
  delete labels[BOT_LABEL_KEYS.helper];
  return {
    ...labels,
    [BOT_LABEL_KEYS.bot]: spec.botKey,
    [BOT_LABEL_KEYS.image]: spec.image,
  };
}

/** ASCII control characters (NUL, newline, ...) and DEL. A newline would also
 *  split an entry of the apply script's removal list in two. */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Why `rest` (the part of a profile file's path after its "hermes/" /
 *  "workspace/" / "scratch/" prefix) is unsafe, or null when it is safe. */
function unsafeRelativePathReason(rest: string): string | null {
  if (rest.length === 0) return "has no path inside the volume";
  if (hasControlCharacter(rest)) return "contains a control character";
  if (rest.includes("\\")) return "contains a backslash";
  if (rest.startsWith("/")) return 'starts with "/"';
  for (const segment of rest.split("/")) {
    if (segment.length === 0) return "has an empty path segment";
    if (segment === "." || segment === "..") return `has a "${segment}" path segment`;
    if (segment.startsWith(RESERVED_SEGMENT_PREFIX)) {
      return `has a segment starting with "${RESERVED_SEGMENT_PREFIX}", which is reserved for the driver's own bookkeeping`;
    }
  }
  return null;
}

/** Which mount a compiled profile file belongs under, and its path inside that
 *  mount. Throws on anything that is not "hermes/…", "workspace/…" or
 *  "scratch/…", or whose remainder could leave that mount, alias another path
 *  or reach the driver's reserved paths: empty/"."/".." segments, a leading
 *  "/", a backslash, a control character, or any segment starting with
 *  ".myrmidon". This function is the enforcement boundary for what reaches the
 *  Docker API (see the module comment above), so it does not trust
 *  compileHermesProfile (G2) to have sanitized its own output first. */
export function resolveProfileFileTarget(file: Pick<CompiledProfileFile, "path">): {
  mount: BotVolumeMount;
  relativePath: string;
} {
  const slash = file.path.indexOf("/");
  const prefix = slash === -1 ? file.path : file.path.slice(0, slash);
  const rest = slash === -1 ? "" : file.path.slice(slash + 1);
  const mount = BOT_VOLUME_MOUNTS.find((candidate) => candidate.hostSuffix === prefix);
  if (!mount) {
    throw new BotContainerTemplateError(
      `profile file path ${JSON.stringify(file.path)} must start with "hermes/", "workspace/" or "scratch/"`,
    );
  }
  const reason = unsafeRelativePathReason(rest);
  if (reason) {
    throw new BotContainerTemplateError(`profile file path ${JSON.stringify(file.path)} ${reason}`);
  }
  return { mount, relativePath: rest };
}
