// server/src/myrmidon/bot-containers/docker-driver.ts
//
// BotContainerDriver implementation over the Docker Engine HTTP API, spoken
// directly over the daemon's unix socket with node:http (no docker client
// dependency — CONVENTIONS.md §8). This is the pilot driver
// (containers-plan-senior-2026-09-28.md §1.4 "intermediate step"): the board still
// holds the socket. Moving the socket out to a separate `fleetd` process later only
// means constructing a different BotContainerDriver in index.ts; this module's
// template enforcement (template.ts) is written so that move can reuse it as-is.
//
// How files reach a bot's volumes. The bot container runs with a read-only root
// filesystem, and Docker refuses `PUT /containers/{id}/archive` into any path of
// such a container that is not inside one of its volumes (moby
// daemon/archive_unix.go: "container rootfs is marked read-only"). So:
//   - every archive is PUT to one volume mount point (`/data/hermes`,
//     `/workspace`, `/scratch`), with entry paths relative to it — never to "/";
//   - the archive carries explicit directory entries (uid 10001, mode 0700)
//     before any file, because Docker creates a missing parent directory itself as
//     root:root 0755, which the uid-10001 swap below could then not modify;
//   - the archive only ever lands in a per-apply staging directory, and a
//     short-lived helper container (same image, uid 10001, no network, every
//     capability dropped, the bot's three binds and nothing else) moves the staged
//     files into place. A helper — not `docker exec` in the bot — because exec
//     needs the bot to be running, and a stopped, crash-looping or freshly created
//     container is exactly when a new profile has to be written.
//   - Volume directories themselves are created by Docker (as root) when a bind
//     source is missing; a second helper, run as root with only CAP_CHOWN and
//     CAP_FOWNER, hands them to uid 10001 with mode 0700 before first use.
//
// Applied state. Docker cannot change a container's labels after creation, so no
// label says what is applied. The swap moves a marker file
// (hermes/.myrmidon/applied.json: both hashes plus the list of profile paths) into
// place as its very last step, and status() reads it back with
// `GET /containers/{id}/archive`, which works in every container state. No marker
// means "nothing verified applied", never "unchanged".
//
// Secrets and the image. The create body carries no secret in `Env`: anything
// there is shown by `docker inspect`. API_SERVER_KEY and every other secret
// reach the gateway only as the profile's hermes/.env, so the image has to read
// them from there. Whether it does is part of the runtime contract an image
// declares (template.ts BOT_RUNTIME_CONTRACT_LABEL); create/recreate refuse an
// image that does not declare it, before anything is created.
//
// BUILD-OFFLOAD C: the single exception is the DEVBUILD_HOST/USER/BASE env of
// the dev-variant image (myrmidon-hermes-dev) when MYRMIDON_DEVBUILD_HOST is
// set: those are internal hostnames and paths, not secrets, so the container
// env is acceptable; the ssh key of the build server is a secret and travels
// only as the read-only file mount /opt/devbuild-ssh, never as env.
// Secrets and the image. The create body carries no secret in `Env` (the only
// variable it may carry is a shared-scope member's own subdirectory name): anything
// there is shown by `docker inspect`. API_SERVER_KEY and every other secret reach the
// gateway only as the profile's hermes/.env, so the image has to read them from
// there. Whether it does is part of the runtime contract an image declares
// (template.ts BOT_RUNTIME_CONTRACT_LABEL); create/recreate refuse an image
// that does not declare it, before anything is created.

import { CLONE_HYGIENE_REPORT_PATH } from "./clone-hygiene.js"; // myrmidon(1.6.2-BOT-DISK-C)
import { randomBytes } from "node:crypto";
import http from "node:http";
import {
  RATE_LIMIT_MAX_RETRIES,
  backoffDelayMs,
  createRateLimiter,
  parseRetryAfterMs,
  type RateLimiter,
} from "./dockergate-pacing.js"; // myrmidon(1.6.5-DOCKERGATE-A2A3-STORM)
import type { BotContainerDriver, BotContainerSpec, BotContainerStatus, TemplateDriftField, TemplateDriftReport } from "./driver.js";
import { ISOLATED_LAYOUT, type ScopeLayout } from "@paperclipai/shared";
import type { CompiledProfile } from "./types.js";
import { logger } from "../../middleware/logger.js";
import { prepareBotSharedMount, resolveSpecSharedMount } from "./shared-mount.js"; // myrmidon(1.6.1-BOT-DISK-D)
import {
  assertBotRuntimeContract,
  botVolumeLayout,
  BOT_LABEL_KEYS,
  BOT_MANAGED_DIRS,
  BOT_KEY_PATTERN,
  BOT_MOUNT_SOURCES_ENV,
  BOT_HERMES_REAL_PATH,
  BOT_ROOT_MOUNT,
  BOT_RUNTIME_SCOPE_LABEL,
  BOT_SCOPE_DATA_TMPFS,
  BOT_SCOPE_SUBDIR_ENV,
  BOT_VOLUME_MOUNTS,
  botRealRootFromBinds,
  buildHelperBinds,
  scopeDirNameFromBinds,
  type BotScopeMount,
  type BotVolumeLayout,
  BotContainerTemplateError,
  buildBinds,
  buildLabels,
  containerNameFor,
  devbuildContainerEnv,
  devbuildKeyMount,
  helperContainerNameFor,
  isDevBuildImage,
  isImageAllowed,
  isUnderManagedDir,
  mountRootSegment,
  parseDevbuildSettings,
  parseImageAllowlist,
  parseMountSourceAllowlist,
  replacementContainerNameFor,
  resolveProfileFileTarget,
  validateBotKey,
  type DevbuildSettings,
} from "./template.js";
import { buildUstarArchive, parseUstarArchive, type UstarEntry } from "./ustar.js";

export const BOT_DOCKER_SOCKET_ENV = "MYRMIDON_BOT_DOCKER_SOCKET";
export const DEFAULT_BOT_DOCKER_SOCKET = "/var/run/docker.sock";
export const BOT_IMAGE_ALLOWLIST_ENV = "MYRMIDON_BOT_IMAGE_ALLOWLIST";
export const BOT_VOLUME_ROOT_ENV = "MYRMIDON_BOT_VOLUME_ROOT";
export const BOT_NETWORK_ENV = "MYRMIDON_BOT_NETWORK";
/** myrmidon(BOT-DISK-F): host directory of shared isolation-scope instances; default `<volumeRoot>/.scopes`. */
export const BOT_SCOPE_ROOT_ENV = "MYRMIDON_BOT_SCOPE_ROOT";
export const DEFAULT_BOT_NETWORK = "myrmidon-bots";

/** uid:gid the image runs the gateway as (non-root; the bot image's `USER`).
 *  Profile files and every directory the driver creates are owned by it. */
export const BOT_CONTAINER_UID = 10001;

const DOCKER_API_VERSION = "v1.45";
/** Seconds Docker waits after SIGTERM before SIGKILL on stop/restart. */
export const BOT_STOP_TIMEOUT_SEC = 30;
const DEFAULT_START_HEALTH_TIMEOUT_MS = 120_000;
// myrmidon(1.6.5-DOCKERGATE-A2A3-STORM): 1 s polling of a container's health was
// the rollout's second storm source — a 120 s wait meant up to 120 A2 inspects
// per bot, and dockergate bills every one against the per-bot inspect bucket and
// the global rate. The image's HEALTHCHECK interval is 30 s; polling faster than
// that re-reads the same verdict. 5 s is the floor the fleet budget allows.
const DEFAULT_HEALTH_POLL_INTERVAL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 60_000;
const HELPER_WAIT_TIMEOUT_MS = 120_000;
const HELPER_MEMORY_BYTES = 128 * 1024 * 1024;
const HELPER_PIDS_LIMIT = 64;

const DEFAULT_TEMPLATE_CONTEXT_TTL_MS = 60_000;
const HERMES_MOUNT = BOT_VOLUME_MOUNTS.find((mount) => mount.hostSuffix === "hermes")!;
/** Applied-state marker, relative to the hermes mount. */
const MARKER_RELATIVE_PATH = ".myrmidon/applied.json";
// Read at its real path inside the single mount, not through the image's /data/hermes link.
export const APPLIED_MARKER_CONTAINER_PATH = `${BOT_HERMES_REAL_PATH}/${MARKER_RELATIVE_PATH}`;

export interface DockerDriverConfig {
  socketPath: string;
  volumeRoot: string;
  /** myrmidon(BOT-DISK-F): host directory of shared scope instances (one subdirectory per instance). */
  scopeRoot?: string;
  network: string;
  allowlist: readonly string[];
  /** Host directories a card may mount into a bot container, read-only
   *  (MYRMIDON_BOT_MOUNT_SOURCES). Empty means "nothing extra may be mounted". */
  mountSources: readonly string[];
  /** BUILD-OFFLOAD C: parsed MYRMIDON_DEVBUILD_* settings. host: null — the
   *  devbuild wiring is off; no DEVBUILD_* env and no key mount is added to any
   *  container. Only a dev-variant image (isDevBuildImage) ever gets them. */
  devbuild: DevbuildSettings;
  /** myrmidon(1.6.5-DOCKERGATE-A2A3-STORM): MYRMIDON_DOCKERGATE_MAX_RPS — the
   *  ceiling of board→gate requests per second across every loop (sweep, health
   *  wait, clone-report collection, "apply now"). The gate's own global bucket is
   *  50/s (tools/dockergate/internal/config/config.go: GlobalRate); the board
   *  stays under it with margin so a rollout never rides the gate's limit.
   *  0 disables the client-side bucket; absent (a config built in tests, not by
   *  readDockerDriverConfig) means the same: pacing off. */
  maxRps?: number;
}

/** MYRMIDON_DOCKERGATE_MAX_RPS: 0..50 requests/s, default 20 (half the gate's
 *  global bucket: a second caller — fleetd, a future collector — shares it). */
export const DOCKERGATE_MAX_RPS_ENV = "MYRMIDON_DOCKERGATE_MAX_RPS";
const DEFAULT_DOCKERGATE_MAX_RPS = 20;

export function readDockerDriverConfig(env: NodeJS.ProcessEnv = process.env): DockerDriverConfig {
  const volumeRoot = env[BOT_VOLUME_ROOT_ENV]?.trim();
  if (!volumeRoot) {
    throw new BotContainerTemplateError(`${BOT_VOLUME_ROOT_ENV} must be set to use the bot container driver`);
  }
  let maxRps = DEFAULT_DOCKERGATE_MAX_RPS;
  const rawRps = env[DOCKERGATE_MAX_RPS_ENV]?.trim();
  if (rawRps) {
    const value = Number(rawRps);
    if (Number.isFinite(value) && value >= 0 && value <= 50) maxRps = value;
  }
  return {
    socketPath: env[BOT_DOCKER_SOCKET_ENV]?.trim() || DEFAULT_BOT_DOCKER_SOCKET,
    volumeRoot,
    // "." can never begin a bot key, so the default cannot collide with a bot's directory.
    scopeRoot: env[BOT_SCOPE_ROOT_ENV]?.trim() || `${volumeRoot}/.scopes`,
    network: env[BOT_NETWORK_ENV]?.trim() || DEFAULT_BOT_NETWORK,
    allowlist: parseImageAllowlist(env[BOT_IMAGE_ALLOWLIST_ENV]),
    mountSources: parseMountSourceAllowlist(env[BOT_MOUNT_SOURCES_ENV]),
    devbuild: parseDevbuildSettings(env),
    maxRps,
  };
}

/** Test hooks; production code passes none. */
export interface DockerDriverOptions {
  sleep?: (ms: number) => Promise<void>;
  startHealthTimeoutMs?: number;
  healthPollIntervalMs?: number;
  /**
   * myrmidon(OPE-4789): how long one freshly read template context (shared
   * package cache path, git-mirror flag, scope layout) stays valid for a bot.
   * Every template use — the drift check, create, recreate — read all three
   * per call, so one unchanged reconcile pass re-read the same instance
   * settings row three times. These values change at most when the operator
   * saves the bot-disk settings (or applies a scope change), both of which the
   * caller applies within seconds; 60 s of reuse per bot is far inside that,
   * and the bound keeps a changed value from being held onto indefinitely.
   * Tests pass 0 to disable the cache. Default 60 s.
   */
  templateContextTtlMs?: number;
  /** Staging-directory nonce generator (hex). */
  nonce?: () => string;
  /**
   * myrmidon(1.6.5-DOCKERGATE-A2A3-STORM): the wall clock and the jitter source
   * of the 429 retry backoff (see dockergate-pacing.ts). Tests inject a fixed
   * clock and rng to assert the retry schedule without waiting on time.
   */
  clock?: () => number;
  rng?: () => number;
  /**
   * myrmidon(1.6.1-BOT-DISK-B): the shared package cache path from the
   * instance settings (`general.botDisk`), or undefined when none is set. Read
   * on every create, recreate and drift check, so a settings change reaches the
   * next reconcile pass without a restart and a fresh process never compares a
   * container against a path it has not loaded yet. Absent: no shared cache.
   */
  readSharedPackageCachePath?: (botKey: string) => Promise<string | undefined>;
  /**
   * myrmidon(1.6.2-BOT-DISK-C): whether the instance keeps git mirrors
   * (`general.botDisk.gitMirrorRepos` not empty), read with the cache path on
   * every create, recreate and drift check. True adds the read-only
   * `<cache>/git:/cache/git` bind. Absent: never.
   */
  readGitMirrorEnabled?: (botKey: string) => Promise<boolean>;
  /**
   * myrmidon(1.6.5-BOT-DISK-H11): the host directory the instance shares the bot
   * runtime from (`general.botDisk.sharedBotRuntimePath`), read with the cache
   * path on every create, recreate and drift check. Set adds three READ-ONLY
   * binds (`<root>/bin`, `<root>/lazy-packages`, `<root>/lsp`) over the bot's
   * own runtime paths, so the instance keeps one copy instead of one per bot.
   * Absent: every bot keeps its own.
   */
  readSharedBotRuntimePath?: (botKey: string) => Promise<string | undefined>;
  /**
   * myrmidon(BOT-DISK-F): the layout the board keeps this bot's disk on (its own
   * directory, or a member subdirectory of a shared scope instance), read on
   * every create, recreate and drift check. It is the layout the owner applied,
   * not the one the resolver currently computes: a scope change waits for the
   * owner's "apply" (restart required). Absent: always isolated.
   */
  readScopeLayout?: (botKey: string) => Promise<ScopeLayout>;
  /**
   * myrmidon(BOT-DISK-F): moves a bot's directories between host layouts when a
   * recreate changes the layout. `check` runs before anything is stopped and
   * throws when the move would conflict (or the board cannot see the volumes);
   * `run` runs with the old container stopped and the new one not yet created.
   * Absent: a recreate that changes the layout is refused.
   */
  scopeMigration?: {
    check(args: { botKey: string; from: ScopeLayout; to: ScopeLayout }): Promise<void>;
    run(args: { botKey: string; from: ScopeLayout; to: ScopeLayout }): Promise<void>;
  };
}

export interface DockerCreateContainerBody {
  Image: string;
  Labels: Record<string, string>;
  /** A shared-scope member carries its subdirectory name; a dev-variant bot
   *  carries the DEVBUILD_* triple (BUILD-OFFLOAD C). Neither is a secret. */
  Env?: string[];
  HostConfig: {
    Memory: number;
    NanoCpus: number;
    PidsLimit: number;
    CapDrop: string[];
    SecurityOpt: string[];
    ReadonlyRootfs: boolean;
    Tmpfs: Record<string, string>;
    Init: boolean;
    RestartPolicy: { Name: string };
    NetworkMode: string;
    Binds: string[];
    Privileged: boolean;
  };
}

/**
 * Pure builder for the `POST /containers/create` body — the actual "fixed
 * template" enforcement. Never adds anything a caller passed beyond `spec`'s
 * fields: no arbitrary binds, no host network, no privileged mode, and no
 * `Env` beyond the two driver-owned exceptions: the DEVBUILD_* triple of a
 * dev-variant image with the devbuild wiring on (BUILD-OFFLOAD C; internal
 * hostnames and paths, not secrets) and a shared-scope member's own
 * subdirectory name. Throws on an image outside the allowlist, a network
 * other than the one configured for this driver, or an extra mount whose
 * source is not in
 * MYRMIDON_BOT_MOUNT_SOURCES (template.ts buildBinds). `sharedPackageCachePath`
 * (instance settings, 1.6.1-BOT-DISK-B) adds the fixed package cache binds.
 * `volumeLayout` is the layout the image's runtime contract pins (template.ts
 * botVolumeLayout): a "legacy" image gets the three separate binds it boots
 * from, anything else (the default — every existing caller and fixture passes
 * none) gets the single mount. The layout of an image is decided from its own
 * labels by requireBotImage before create/recreate/drift ever build a body, so
 * a body can never carry the new scheme under an old image.
 */
export function buildCreateContainerRequestBody(
  spec: BotContainerSpec,
  config: Pick<DockerDriverConfig, "volumeRoot" | "network" | "allowlist" | "mountSources" | "devbuild">,
  sharedPackageCachePath?: string,
  gitMirror = false,
  /** myrmidon(BOT-DISK-F): the instance a shared member binds (isolated when absent). */
  scope?: BotScopeMount,
  /** myrmidon(BOT-DISK-D layout versioning): the bind layout the image's contract declares. */
  volumeLayout: BotVolumeLayout = "single",
  /** myrmidon(1.6.5-BOT-DISK-H11): `general.botDisk.sharedBotRuntimePath` (absent: per-bot runtime). */
  sharedBotRuntimePath?: string,
): DockerCreateContainerBody {
  validateBotKey(spec.botKey);
  if (!isImageAllowed(spec.image, config.allowlist)) {
    throw new BotContainerTemplateError(`image "${spec.image}" is not in ${BOT_IMAGE_ALLOWLIST_ENV}`);
  }
  if (spec.network !== config.network) {
    throw new BotContainerTemplateError(
      `network "${spec.network}" does not match this driver's ${BOT_NETWORK_ENV} ("${config.network}")`,
    );
  }
  if (spec.memoryMb <= 0 || spec.cpus <= 0 || spec.pidsLimit <= 0) {
    throw new BotContainerTemplateError("memoryMb, cpus and pidsLimit must all be positive");
  }
  // BUILD-OFFLOAD C: the devbuild env and the read-only key mount go only to a
  // dev-variant image, and only when MYRMIDON_DEVBUILD_HOST is set. The key
  // mount rides the ordinary extra-mount path (its source must be listed in
  // MYRMIDON_BOT_MOUNT_SOURCES and its container path is reserved, so a card
  // can neither invent the source nor take the path over); it is appended
  // after the card's own mounts, and a card cannot ask for it itself.
  const devbuild: DevbuildSettings = isDevBuildImage(spec.image)
    ? config.devbuild
    : { host: null, user: "", base: "" };
  const env = devbuildContainerEnv(devbuild);
  const keyMount = devbuildKeyMount(devbuild, config.mountSources);
  // A legacy image never runs as a shared member: the scope layout needs the
  // image's start-time links (BOT_RUNTIME_SCOPE_LABEL), which only single-
  // layout images have. Callers keep the layouts apart, but the body builder
  // refuses to mix them rather than emit a body nothing can boot.
  if (scope && volumeLayout === "legacy") {
    throw new BotContainerTemplateError(
      `image "${spec.image}" declares the legacy volume layout, which cannot bind a shared scope instance`,
    );
  }
  return {
    Image: spec.image,
    Labels: buildLabels(spec),
    ...(env
      ? { Env: Object.entries(env).map(([name, value]) => `${name}=${value}`) }
      : scope
        ? { Env: [`${BOT_SCOPE_SUBDIR_ENV}=${spec.botKey}`] }
        : {}),
    HostConfig: {
      Memory: Math.round(spec.memoryMb * 1024 * 1024),
      NanoCpus: Math.round(spec.cpus * 1_000_000_000),
      PidsLimit: spec.pidsLimit,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      ReadonlyRootfs: true,
      // A member's /data holds only the links into its own subdirectory (entrypoint.sh).
      Tmpfs: scope ? { "/tmp": "", "/data": BOT_SCOPE_DATA_TMPFS } : { "/tmp": "" },
      Init: true,
      RestartPolicy: { Name: "on-failure" },
      NetworkMode: config.network,
      Binds: buildBinds(config.volumeRoot, spec.botKey, {
        mounts: spec.extraMounts,
        allowedSources: config.mountSources,
        sharedPackageCachePath,
        sharedBotRuntimePath,
        gitMirror,
        driverMount: keyMount,
        scope,
        volumeLayout,
        // myrmidon(1.6.1-BOT-DISK-D): the shared directory, bound at /shared.
        sharedMount: resolveSpecSharedMount(spec, config.volumeRoot),
      }),
      Privileged: false,
    },
  };
}

export type HelperRole = "prepare-volumes" | "apply-profile";

export interface DockerHelperContainerBody {
  Image: string;
  User: string;
  Entrypoint: string[];
  Cmd: string[];
  Labels: Record<string, string>;
  NetworkDisabled: boolean;
  HostConfig: {
    Memory: number;
    PidsLimit: number;
    CapDrop: string[];
    CapAdd: string[];
    SecurityOpt: string[];
    ReadonlyRootfs: boolean;
    RestartPolicy: { Name: string };
    NetworkMode: string;
    Binds: string[];
    Privileged: boolean;
  };
}

/**
 * Pure builder for a helper container: the bot's own image with its entrypoint
 * replaced by `/bin/sh -c <script> myrmidon-helper /`, the bot's three binds and
 * nothing else, no network, every capability dropped. "prepare-volumes" runs as
 * root with CAP_CHOWN and CAP_FOWNER added back — just enough to chmod/chown the
 * three mount points; "apply-profile" runs as the bot's own uid with no
 * capability at all. The script is always driver-generated (buildApplyScript /
 * buildPrepareVolumesScript) and contains no profile data.
 */
export function buildHelperContainerRequestBody(params: {
  botKey: string;
  image: string;
  role: HelperRole;
  script: string;
  volumeRoot: string;
  /** myrmidon(BOT-DISK-F): the helper of a shared member works inside its subdirectory of the instance. */
  scope?: BotScopeMount;
}): DockerHelperContainerBody {
  validateBotKey(params.botKey);
  const asRoot = params.role === "prepare-volumes";
  return {
    Image: params.image,
    User: asRoot ? "0:0" : `${BOT_CONTAINER_UID}:${BOT_CONTAINER_UID}`,
    Entrypoint: ["/bin/sh", "-c"],
    Cmd: [params.script, "myrmidon-helper", "/"],
    Labels: { [BOT_LABEL_KEYS.helper]: params.botKey },
    NetworkDisabled: true,
    HostConfig: {
      Memory: HELPER_MEMORY_BYTES,
      PidsLimit: HELPER_PIDS_LIMIT,
      CapDrop: ["ALL"],
      CapAdd: asRoot ? ["CHOWN", "FOWNER"] : [],
      SecurityOpt: ["no-new-privileges"],
      ReadonlyRootfs: true,
      RestartPolicy: { Name: "no" },
      NetworkMode: "none",
      Binds: buildHelperBinds(params.volumeRoot, params.botKey, params.scope, asRoot),
      Privileged: false,
    },
  };
}

const MOUNT_ROOTS = BOT_VOLUME_MOUNTS.map((mount) => mountRootSegment(mount));
/** The prepare helper's bind of the instance directory, relative to its root ("/scope"). */
const BOT_SCOPE_HELPER_ROOT = "scope";
const NONCE_PATTERN = /^[0-9a-f]{8,64}$/;

function scopeLayoutKeyOf(layout: ScopeLayout): string {
  return layout.kind === "isolated" ? "isolated" : `shared:${layout.dirName}`;
}

function stagingDirName(nonce: string): string {
  return `.myrmidon-next-${nonce}`;
}

function applyDirName(nonce: string): string {
  return `.myrmidon-apply-${nonce}`;
}

/** Script the "prepare-volumes" helper runs (as root, CAP_CHOWN + CAP_FOWNER):
 *  hands each mount point to the bot's uid with mode 0700. Idempotent. Paths are
 *  relative to "$1" (the container root in production). */
export function buildPrepareVolumesScript(options: { scope?: boolean } = {}): string {
  // myrmidon(BOT-DISK-F): a member of a shared scope instance also hands the instance
  // directory (the helper's /scope bind) to the bot, so the container can create the
  // instance's pnpm store in it. The text stays a constant per layout.
  // myrmidon(BOT-ROOT-TRAVERSE): an isolated bot gets ONE bind — its whole directory at
  // /bot — and the three narrow chmods above never reach the root of that bind. Since
  // #572 a root left externally as e.g. 0710 (rc.1: root:65532 on 51/74 bots) hides the
  // entire tree from uid 10001 and the bot dies on a missing API_SERVER_KEY, far from
  // the real cause. So the prepare helper also binds the root itself (same bind string
  // as the bot container) and fixes its traversal here: one non-recursive chmod 0711,
  // owner untouched (the gate keeps demanding a root-owned volume.K), content never
  // listed or written — "x" without "r" is exactly "the bot can enter, cannot browse".
  // A shared member's root IS the instance directory ("scope" below): chmod 0700 +
  // chown 10001 already makes it enterable by the uid every member runs as.
  const roots = options.scope ? [...MOUNT_ROOTS, BOT_SCOPE_HELPER_ROOT] : MOUNT_ROOTS;
  const lines = [
    "set -eu",
    'cd "$1"',
    `for d in ${roots.join(" ")}; do`,
    '  chmod 0700 "$d"',
    `  chown ${BOT_CONTAINER_UID}:${BOT_CONTAINER_UID} "$d"`,
    "done",
  ];
  if (!options.scope) lines.push(`chmod 0711 ${BOT_ROOT_MOUNT.slice(1)}`);
  return lines.join("\n");
}

/**
 * Script the "apply-profile" helper runs (as the bot's uid) after the staged
 * archives have been PUT. Paths are relative to "$1" (the container root in
 * production). In order:
 *   1. drop staging left behind by any earlier, interrupted apply (any other
 *      nonce), so its files can never be moved into place by this one;
 *   2. replace every compiler-owned directory (BOT_MANAGED_DIRS) wholesale:
 *      the live one is renamed aside, the staged one renamed into place — a skill
 *      removed from the card disappears instead of lingering;
 *   3. move every other staged file over its final path (`mv` is an atomic
 *      rename within the volume), creating parent directories as needed;
 *   4. delete files the previous apply wrote that this profile no longer has
 *      (the list is computed by the driver and staged as remove.list);
 *   4.5 best-effort: delete hermes/backups (the vendor's point-in-time copies
 *      of config.yaml, a possible secret leak — see the step's comment below);
 *   5. only then move the applied-state marker into place, and clean up.
 * `set -e` aborts at the first failure, before the marker moves, so a partial
 * apply is never reported as applied and the next pass simply repeats it.
 * No profile path is ever interpolated into this text: the only variable part
 * is the hex nonce.
 */
export function buildApplyScript(nonce: string): string {
  if (!NONCE_PATTERN.test(nonce)) throw new BotContainerTemplateError(`invalid staging nonce "${nonce}"`);
  const hermesRoot = mountRootSegment(HERMES_MOUNT);
  const applyDir = `${hermesRoot}/${applyDirName(nonce)}`;
  const lines: string[] = [
    "set -eu",
    "umask 077",
    'cd "$1"',
    `n=${nonce}`,
    "# 1. staging from interrupted earlier applies",
    `for root in ${MOUNT_ROOTS.join(" ")}; do`,
    '  for stale in "$root"/.myrmidon-next-* "$root"/.myrmidon-apply-* "$root"/.myrmidon-old-*; do',
    '    [ -e "$stale" ] || continue',
    '    case "${stale#"$root"/}" in',
    '      ".myrmidon-next-$n" | ".myrmidon-apply-$n") ;;',
    '      *) rm -rf -- "$stale" ;;',
    "    esac",
    "  done",
    "done",
    "# 2. compiler-owned directories, replaced wholesale",
  ];
  BOT_MANAGED_DIRS.forEach((dir, index) => {
    const { mount, relativePath } = resolveProfileFileTarget({ path: dir });
    const root = mountRootSegment(mount);
    lines.push(
      `staged="${root}/.myrmidon-next-$n/${relativePath}"`,
      `live="${root}/${relativePath}"`,
      'if [ -d "$staged" ]; then',
      `  old="${root}/.myrmidon-old-$n"`,
      '  mkdir -p -- "$old"',
      `  if [ -e "$live" ] || [ -L "$live" ]; then mv -f -T -- "$live" "$old/${index}"; fi`,
      '  mkdir -p -- "$(dirname -- "$live")"',
      '  mv -f -T -- "$staged" "$live"',
      "fi",
    );
  });
  lines.push(
    "# 3. every other staged file, one atomic rename each",
    `list="${applyDir}/staged.list"`,
    `for root in ${MOUNT_ROOTS.join(" ")}; do`,
    '  staging="$root/.myrmidon-next-$n"',
    '  [ -d "$staging" ] || continue',
    '  (cd "$staging" && find . -type f) > "$list"',
    '  while IFS= read -r rel; do',
    '    rel="${rel#./}"',
    '    mkdir -p -- "$(dirname -- "$root/$rel")"',
    '    mv -f -T -- "$staging/$rel" "$root/$rel"',
    '  done < "$list"',
    "done",
    "# 4. files the previous apply wrote that this profile no longer has",
    `removals="${applyDir}/remove.list"`,
    'if [ -f "$removals" ]; then',
    '  while IFS= read -r p; do',
    '    case "$p" in',
  );
  for (const mount of BOT_VOLUME_MOUNTS) {
    lines.push(`      ${mount.hostSuffix}/*) dest="${mountRootSegment(mount)}/\${p#${mount.hostSuffix}/}" ;;`);
  }
  lines.push(
    "      *) continue ;;",
    "    esac",
    '    if [ -f "$dest" ] || [ -L "$dest" ]; then rm -f -- "$dest"; fi',
    '  done < "$removals"',
    "fi",
    // myrmidon(4329-hermes-config-backup-secrets): remove the vendor's config
    // backups under hermes/backups — hermes_cli/config_backups.py backup_config()
    // (pinned tag v2026.9.24) writes a copy of config.yaml there on every
    // successful config load ("good") and has no setting that turns it off.
    // The compiler's own config.yaml only ever holds a "${VAR}" reference, but
    // a backup copy can hold the resolved key value (260 files across 72 bots
    // on 04.10, per the parent), so every apply wipes the subtree. Step 4.5:
    // best effort — a failure here must not fail the apply, because at this
    // point the new, reference-only config.yaml is already in place and
    // correct; hermes simply recreates backups/config from it on its next
    // load. Runs BEFORE the marker move so the cleanup is covered by the same
    // applied.json transaction: an apply that moved the marker cleaned backups,
    // and one that failed before it left the old profile reported (with the
    // backups still there for the retry to remove).
    "# 4.5 vendor config backups under hermes (possible secret leak), best effort",
    `backups="${hermesRoot}/backups"`,
    'if [ -d "$backups" ]; then',
    '  rm -rf -- "$backups" 2>/dev/null || true',
    'fi',
    "# 5. the applied-state marker, strictly last",
    `mkdir -p -- "${hermesRoot}/${MARKER_RELATIVE_PATH.split("/")[0]}"`,
    `mv -f -T -- "${applyDir}/applied.json" "${hermesRoot}/${MARKER_RELATIVE_PATH}"`,
    `rm -rf -- ${MOUNT_ROOTS.map((root) => `"${root}/.myrmidon-next-$n"`).join(" ")} "${applyDir}" "${hermesRoot}/.myrmidon-old-$n"`,
  );
  return lines.join("\n");
}

export interface AppliedMarker {
  restartHash: string;
  filesHash: string;
  /** Profile paths (CompiledProfileFile.path) this apply wrote. */
  files: string[];
  /** myrmidon(CONCURRENCY-SYNC): gateway.api_server.max_concurrent_runs the applied
   *  profile carries. Absent in markers written before the field existed. */
  maxConcurrentRuns?: number;
}

export function serializeAppliedMarker(profile: CompiledProfile): string {
  const marker: AppliedMarker = {
    restartHash: profile.restartHash,
    filesHash: profile.filesHash,
    files: profile.files.map((file) => file.path).sort(),
    // Only when the profile carries one: an old-style profile keeps a marker without
    // the field, which the card reads as "not reported" rather than as a value.
    ...(profile.maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns: profile.maxConcurrentRuns }),
  };
  return `${JSON.stringify(marker)}\n`;
}

/** Null for anything that is not a well-formed marker: the file lives on a
 *  volume the bot itself can write, so its content is data, not trusted state. */
export function parseAppliedMarker(raw: string): AppliedMarker | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const { restartHash, filesHash, files, maxConcurrentRuns } = parsed as Record<string, unknown>;
  if (typeof restartHash !== "string" || typeof filesHash !== "string") return null;
  const fileList = Array.isArray(files) ? files.filter((path): path is string => typeof path === "string") : [];
  const marker: AppliedMarker = { restartHash, filesHash, files: fileList };
  // A number the driver cannot trust (a hand-edited volume) is simply not carried:
  // the card then says "not reported", and classifyProfileChange heals it.
  if (typeof maxConcurrentRuns === "number" && Number.isInteger(maxConcurrentRuns) && maxConcurrentRuns > 0) {
    marker.maxConcurrentRuns = maxConcurrentRuns;
  }
  return marker;
}

/**
 * Profile paths an earlier apply wrote (from its marker) that `next` no longer
 * has, and that are not under a compiler-owned directory (those are replaced
 * wholesale anyway). Paths read back from the marker are re-validated with
 * resolveProfileFileTarget and silently dropped when unsafe — the marker lives
 * on a bot-writable volume.
 */
export function computeProfileRemovals(previous: readonly string[] | undefined, next: CompiledProfile): string[] {
  if (!previous) return [];
  const keep = new Set(next.files.map((file) => file.path));
  const removals = new Set<string>();
  for (const path of previous) {
    if (keep.has(path) || isUnderManagedDir(path)) continue;
    try {
      resolveProfileFileTarget({ path });
    } catch {
      continue;
    }
    removals.add(path);
  }
  return [...removals].sort();
}

export interface ProfileArchive {
  /** Container path of the volume mount point the archive is PUT to. */
  mountPath: string;
  entries: UstarEntry[];
}

function parentDirs(relativePath: string): string[] {
  const parts = relativePath.split("/");
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

/**
 * Pure: the per-mount archives writeProfile PUTs. Each is relative to its
 * mount point and holds, in order, explicit directory entries (uid/gid 10001,
 * mode 0700: the staging directory, every parent of a staged file, and every
 * compiler-owned directory even when the profile puts nothing in it — that is
 * what empties it) and then the files. The hermes archive also carries the apply
 * metadata: the new marker and the removal list. Throws on an unsafe path, a
 * duplicate path, a file at a compiler-owned directory's own path, or a file
 * whose path another file uses as a directory.
 */
export function buildProfileArchives(
  profile: CompiledProfile,
  opts: { nonce: string; removals: readonly string[]; mtime?: Date },
): ProfileArchive[] {
  if (!NONCE_PATTERN.test(opts.nonce)) throw new BotContainerTemplateError(`invalid staging nonce "${opts.nonce}"`);
  const staging = stagingDirName(opts.nonce);
  const perMount = new Map<string, { dirs: Set<string>; files: UstarEntry[] }>();
  const bucket = (containerPath: string) => {
    let entry = perMount.get(containerPath);
    if (!entry) {
      entry = { dirs: new Set([staging]), files: [] };
      perMount.set(containerPath, entry);
    }
    return entry;
  };
  const owner = { uid: BOT_CONTAINER_UID, gid: BOT_CONTAINER_UID, mtime: opts.mtime };

  // The hermes archive always exists: it carries the marker and the managed
  // skills directory even when the profile has nothing else for it.
  bucket(HERMES_MOUNT.containerPath);
  for (const dir of BOT_MANAGED_DIRS) {
    const { mount, relativePath } = resolveProfileFileTarget({ path: dir });
    const target = bucket(mount.containerPath);
    const staged = `${staging}/${relativePath}`;
    for (const parent of parentDirs(staged)) target.dirs.add(parent);
    target.dirs.add(staged);
  }

  const seen = new Set<string>();
  for (const file of profile.files) {
    const { mount, relativePath } = resolveProfileFileTarget(file);
    if (seen.has(file.path)) {
      throw new BotContainerTemplateError(`profile lists ${JSON.stringify(file.path)} more than once`);
    }
    seen.add(file.path);
    if (BOT_MANAGED_DIRS.includes(file.path)) {
      throw new BotContainerTemplateError(`profile file ${JSON.stringify(file.path)} would replace a compiler-owned directory`);
    }
    const target = bucket(mount.containerPath);
    const staged = `${staging}/${relativePath}`;
    for (const parent of parentDirs(staged)) target.dirs.add(parent);
    target.files.push({
      ...owner,
      path: staged,
      content: Buffer.from(file.content, "utf8"),
      mode: file.secret ? 0o600 : file.mode & 0o777,
    });
  }

  const hermes = bucket(HERMES_MOUNT.containerPath);
  const applyDir = applyDirName(opts.nonce);
  hermes.dirs.add(applyDir);
  hermes.files.push(
    { ...owner, path: `${applyDir}/applied.json`, content: Buffer.from(serializeAppliedMarker(profile), "utf8"), mode: 0o600 },
    {
      ...owner,
      path: `${applyDir}/remove.list`,
      content: Buffer.from(opts.removals.map((path) => `${path}\n`).join(""), "utf8"),
      mode: 0o600,
    },
  );

  const archives: ProfileArchive[] = [];
  for (const mount of BOT_VOLUME_MOUNTS) {
    const target = perMount.get(mount.containerPath);
    if (!target) continue;
    for (const file of target.files) {
      if (target.dirs.has(file.path)) {
        throw new BotContainerTemplateError(`profile path "${file.path}" is used both as a file and as a directory`);
      }
    }
    const dirs = [...target.dirs].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
    archives.push({
      mountPath: mount.containerPath,
      entries: [
        ...dirs.map((path): UstarEntry => ({ ...owner, path, type: "directory", content: Buffer.alloc(0), mode: 0o700 })),
        ...[...target.files].sort((a, b) => a.path.localeCompare(b.path)),
      ],
    });
  }
  return archives;
}

interface DockerInspect {
  Id: string;
  /** Image id the container runs (sha256:…). */
  Image: string;
  Config?: { Image?: string; Labels?: Record<string, string> };
  State?: { Status?: string; ExitCode?: number; Health?: { Status?: string } };
  HostConfig?: { Memory?: number; NanoCpus?: number; PidsLimit?: number; NetworkMode?: string; Binds?: string[] };
}

/**
 * The container-template fields the drift check compares, in the order the log
 * names them. `field` is the dotted path inside a container inspect — the same
 * path dockergate's A2 answer uses — so this table is also the contract with
 * dockergate (tools/dockergate/internal/upstream/inspect.go): every path here
 * must come back through the proxy. tools/dockergate/contract/emit-fixtures.ts
 * writes this list into inspect-contract.json and the gate's contract test
 * checks the A2 answer against it, so dockergate dropping a field (the 01.10
 * incident: HostConfig.Binds) turns CI red instead of recreating every bot on
 * every pass.
 */
const DRIFT_READS: ReadonlyArray<{
  field: string;
  actual: (info: Pick<DockerInspect, "Config" | "HostConfig">) => unknown;
  expected: (body: DockerCreateContainerBody) => unknown;
}> = [
  { field: "Config.Image", actual: (info) => info.Config?.Image, expected: (body) => body.Image },
  { field: "HostConfig.Memory", actual: (info) => info.HostConfig?.Memory, expected: (body) => body.HostConfig.Memory },
  { field: "HostConfig.NanoCpus", actual: (info) => info.HostConfig?.NanoCpus, expected: (body) => body.HostConfig.NanoCpus },
  { field: "HostConfig.PidsLimit", actual: (info) => info.HostConfig?.PidsLimit, expected: (body) => body.HostConfig.PidsLimit },
  {
    field: "HostConfig.NetworkMode",
    actual: (info) => info.HostConfig?.NetworkMode,
    expected: (body) => body.HostConfig.NetworkMode,
  },
  { field: "HostConfig.Binds", actual: (info) => info.HostConfig?.Binds, expected: (body) => body.HostConfig.Binds },
];

/** Dotted inspect paths the drift check reads; emitted as the board side of the
 *  inspect contract with dockergate. */
export const CONTAINER_TEMPLATE_INSPECT_FIELDS: readonly string[] = DRIFT_READS.map((read) => read.field);

/** True when two inspect/body values are the same template value. Arrays
 *  compare element by element and in order: Docker returns the binds as they
 *  were created, and a card that added, removed or reordered an extra mount is
 *  a template drift. */
function sameTemplateValue(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(actual) || Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      Array.isArray(expected) &&
      actual.length === expected.length &&
      actual.every((value, index) => value === expected[index])
    );
  }
  return actual === expected;
}

/**
 * Pure drift check, field by field: which template fields of `existing` (a
 * container's live inspect) no longer match `body` (a freshly built
 * create-request)? Empty means the container still matches `body`. Comparing
 * like with like: both sides must carry every field (an inspect that does not
 * report one counts as a drift of that field, which is what the log names).
 */
export function templateDriftFields(
  existing: Pick<DockerInspect, "Config" | "HostConfig">,
  body: DockerCreateContainerBody,
): TemplateDriftField[] {
  const fields: TemplateDriftField[] = [];
  for (const read of DRIFT_READS) {
    const expected = read.expected(body);
    const actual = read.actual(existing);
    if (!sameTemplateValue(actual, expected)) fields.push({ field: read.field, expected, actual });
  }
  return fields;
}

/** The value the drift check expects to read back from a container created
 *  from `body`, per field it compares. The board side of the inspect contract
 *  with dockergate (contract/emit-fixtures.ts). */
export function containerTemplateInspectExpectation(
  body: DockerCreateContainerBody,
): Array<{ path: string; value: unknown }> {
  return DRIFT_READS.map((read) => ({ path: read.field, value: read.expected(body) }));
}

/**
 * Pure drift check: does `existing` (a container's live inspect) still match
 * `body` (a freshly built create-request) on every field that identifies the
 * container's *template* — image, the three resource limits, the network and
 * the bind list (which carries the card's extra mounts)?
 */
export function containerTemplateDrifted(
  existing: Pick<DockerInspect, "Config" | "HostConfig">,
  body: DockerCreateContainerBody,
): boolean {
  return templateDriftFields(existing, body).length > 0;
}

/**
 * Pure: a bot's state from its inspect. Health comes only from Docker's own
 * health check (`State.Health`, the image's HEALTHCHECK with its retries), never
 * from a one-off probe by the board: one slow answer, or the board simply not
 * being on the bot network, must not read as "unhealthy" and trigger a restart.
 * An image without a HEALTHCHECK is judged by its running state alone.
 */
export function botStateFromInspect(info: Pick<DockerInspect, "State">): "running" | "unhealthy" | "stopped" {
  if (info.State?.Status !== "running") return "stopped";
  return info.State.Health?.Status === "unhealthy" ? "unhealthy" : "running";
}

/** Docker's multiplexed log stream (no TTY): 8-byte frame headers. */
export function demuxDockerLogs(buf: Buffer): string {
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const stream = buf[offset];
    if (stream > 2 || buf[offset + 1] !== 0 || buf[offset + 2] !== 0 || buf[offset + 3] !== 0) {
      return buf.toString("utf8");
    }
    const size = buf.readUInt32BE(offset + 4);
    chunks.push(buf.subarray(offset + 8, offset + 8 + size));
    offset += 8 + size;
  }
  return Buffer.concat(chunks).toString("utf8");
}

interface DockerHttpResponse {
  status: number;
  body: Buffer;
  /** Lower-cased response headers; needed for `Retry-After` on a 429. */
  headers: Record<string, string>;
}

function dockerRequest(
  socketPath: string,
  opts: { method: string; path: string; body?: Buffer; headers?: Record<string, string>; timeoutMs?: number },
): Promise<DockerHttpResponse> {
  return new Promise((resolve, reject) => {
    const headers = { ...opts.headers };
    if (opts.body) headers["Content-Length"] = String(opts.body.length);
    const req = http.request(
      { socketPath, path: `/${DOCKER_API_VERSION}${opts.path}`, method: opts.method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks),
            headers: Object.fromEntries(
              Object.entries(res.headers).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(", ") : (value ?? "")]),
            ),
          }),
        );
      },
    );
    const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`docker API ${opts.method} ${opts.path} timed out after ${timeoutMs}ms`));
    });
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function describeFailure(what: string, res: DockerHttpResponse): Error {
  return new Error(`${what} failed: ${res.status} ${res.body.toString("utf8").slice(0, 300)}`);
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Path segment for a container or image name in an API URL. */
function nameSegment(name: string): string {
  return name.split("/").map(encodeURIComponent).join("/");
}

/** Constructs a working driver from the environment; throws if MYRMIDON_BOT_VOLUME_ROOT
 *  is unset (evaluated lazily — only when the caller actually needs a driver, so
 *  importing this module never fails on a host that has bot containers disabled). */
export function dockerBotContainerDriver(
  config: DockerDriverConfig = readDockerDriverConfig(),
  options: DockerDriverOptions = {},
): BotContainerDriver {
  const { socketPath } = config;
  const sleep = options.sleep ?? realSleep;
  const startHealthTimeoutMs = options.startHealthTimeoutMs ?? DEFAULT_START_HEALTH_TIMEOUT_MS;
  const healthPollIntervalMs = options.healthPollIntervalMs ?? DEFAULT_HEALTH_POLL_INTERVAL_MS;
  const templateContextTtlMs = options.templateContextTtlMs ?? DEFAULT_TEMPLATE_CONTEXT_TTL_MS;
  const newNonce = options.nonce ?? (() => randomBytes(8).toString("hex"));
  // myrmidon(1.6.5-DOCKERGATE-A2A3-STORM): the clock and jitter source of the
  // pacing layer (dockergate-pacing.ts); tests drive them to assert the schedule.
  const clock = options.clock ?? (() => Date.now());
  const rng = options.rng ?? Math.random;
  const limiter: RateLimiter = createRateLimiter({ ratePerSec: config.maxRps ?? 0, clock, sleep });
  const readSharedPackageCachePath = options.readSharedPackageCachePath ?? (async () => undefined);
  const readSharedBotRuntimePath = options.readSharedBotRuntimePath ?? (async () => undefined);
  const readGitMirrorEnabled = options.readGitMirrorEnabled ?? (async () => false);
  const readScopeLayout = options.readScopeLayout ?? (async () => ISOLATED_LAYOUT);
  const scopeRoot = config.scopeRoot ?? `${config.volumeRoot}/.scopes`;
  /** The bind place of a layout; undefined for isolated. */
  const scopeMountOf = (layout: ScopeLayout): BotScopeMount | undefined =>
    layout.kind === "shared" ? { scopeRoot, dirName: layout.dirName } : undefined;
  /** The layout a live container was created with, read off its binds. */
  const layoutOfInspect = (info: Pick<DockerInspect, "HostConfig">): ScopeLayout => {
    const dirName = scopeDirNameFromBinds(info.HostConfig?.Binds, scopeRoot);
    return dirName ? { kind: "shared", dirName } : ISOLATED_LAYOUT;
  };
  // myrmidon(1.6.2-BOT-DISK-C): the create body with the cache binds in force right now.
  // myrmidon(OPE-4789): the context reads behind it (cache path, git-mirror
  // flag, scope layout) are cached per bot for templateContextTtlMs — see
  // templateContextFor below.
  // `volumeLayout` (BOT-LAYOUT-V) is the bind layout the image's runtime
  // contract pins (requireBotImage): the body of a legacy image always carries
  // the three separate binds, so a drift is never diagnosed against a layout
  // the image cannot boot.
  const createBody = async (spec: BotContainerSpec, layout?: ScopeLayout, volumeLayout?: BotVolumeLayout) => {
    const context = await templateContextFor(spec.botKey, layout);
    return buildCreateContainerRequestBody(
      spec,
      config,
      context.cachePath,
      context.gitMirror,
      scopeMountOf(context.layout),
      volumeLayout,
      context.runtimePath,
    );
  };

  /**
   * myrmidon(OPE-4789 + 1.6.5-DOCKERGATE-A2A3-STORM): every request goes through
   * this wrapper — paced and 429-aware.
   *  - Every call first takes a token of the client-side bucket (config.maxRps),
   *    so the loops the board runs concurrently (the reconcile sweep, the health
   *    wait, the clone-report collector, "apply now") cannot add up past the
   *    gate's global bucket between them.
   *  - A 429 from dockergate itself (`rate_limited` / `concurrency_limited`) pauses
   *    this call by the gate's `Retry-After` hint when one arrives, otherwise by an
   *    exponential backoff with full jitter (dockergate-pacing.ts), and asks again
   *    up to RATE_LIMIT_MAX_RETRIES times before the answer is handed back as the
   *    failure it is.
   *  - Every other status passes through untouched (the callers' 404/400 handling
   *    stays exactly as it was).
   */
  async function requestWithRateLimitRetry(opts: Parameters<typeof dockerRequest>[1]): Promise<DockerHttpResponse> {
    for (let attempt = 0; ; attempt += 1) {
      await limiter.acquire();
      const res = await dockerRequest(socketPath, opts);
      if (!isGateRateDenial(res)) return res;
      if (attempt >= RATE_LIMIT_MAX_RETRIES) return res;
      const retryAfterMs = parseRetryAfterMs(res.headers["retry-after"], clock());
      await sleep(retryAfterMs ?? backoffDelayMs(attempt + 1, { rng }));
    }
  }

  /** True for dockergate's flood answers: 429 with a denial body from the gate
   *  itself. A 429 from the Docker daemon (it has none on these routes) is not
   *  retried here — the caller's own error path reports it. */
  function isGateRateDenial(res: DockerHttpResponse): boolean {
    if (res.status !== 429) return false;
    const body = res.body.toString("utf8");
    return body.includes("rate_limited") || body.includes("concurrency_limited");
  }
  /**
   * myrmidon(OPE-4789): the template context (shared cache path, git-mirror
   * flag, scope layout) behind one bot's create body. `createBody` is used by
   * the drift check, create and recreate alike; the three option reads inside
   * it each hit the instance settings (and scope store) per call, so one
   * unchanged reconcile pass read the same row three times. The cache keeps
   * the triple per bot for `templateContextTtlMs`; a failed read is never
   * cached (the next call asks again).
   */
  interface TemplateContext {
    atMs: number;
    cachePath: string | undefined;
    /** myrmidon(1.6.5-BOT-DISK-H11): `general.botDisk.sharedBotRuntimePath`. */
    runtimePath: string | undefined;
    gitMirror: boolean;
    layout: ScopeLayout;
  }
  const templateContextCache = new Map<string, TemplateContext>();
  const templateContextInFlight = new Map<string, Promise<TemplateContext>>();

  async function templateContextFor(botKey: string, layoutOverride?: ScopeLayout): Promise<TemplateContext> {
    if (layoutOverride) {
      // A caller that already knows the layout (create/recreate read it as part
      // of their own flow) still shares the cached cache-path/git-mirror pair.
      const cached = templateContextCache.get(botKey);
      if (cached && Date.now() - cached.atMs < templateContextTtlMs) {
        return { ...cached, layout: layoutOverride };
      }
      const [cachePath, runtimePath, gitMirror] = await Promise.all([
        readSharedPackageCachePath(botKey),
        readSharedBotRuntimePath(botKey),
        readGitMirrorEnabled(botKey),
      ]);
      const fresh: TemplateContext = { atMs: Date.now(), cachePath, runtimePath, gitMirror, layout: layoutOverride };
      templateContextCache.set(botKey, fresh);
      return fresh;
    }
    const cached = templateContextCache.get(botKey);
    if (cached && Date.now() - cached.atMs < templateContextTtlMs) return cached;
    const pending = templateContextInFlight.get(botKey);
    if (pending) return pending;
    const read = (async (): Promise<TemplateContext> => {
      const [cachePath, runtimePath, gitMirror, layout] = await Promise.all([
        readSharedPackageCachePath(botKey),
        readSharedBotRuntimePath(botKey),
        readGitMirrorEnabled(botKey),
        readScopeLayout(botKey),
      ]);
      const fresh: TemplateContext = { atMs: Date.now(), cachePath, runtimePath, gitMirror, layout };
      templateContextCache.set(botKey, fresh);
      return fresh;
    })();
    templateContextInFlight.set(botKey, read);
    try {
      return await read;
    } finally {
      templateContextInFlight.delete(botKey);
    }
  }

  /** One live inspect per (bot, moment): a sweep pass and a canary wave
   *  reconcile of the same bot overlap regularly (OPE-4789); both need the
   *  same inspect within milliseconds of each other, so the second shares the
   *  first's in-flight request instead of doubling it. Failures are shared
   *  too — the entry is dropped either way once settled. */
  const inspectInFlight = new Map<string, Promise<DockerInspect | null>>();

  async function inspectByName(name: string): Promise<DockerInspect | null> {
    const pending = inspectInFlight.get(name);
    if (pending) return pending;
    const read = (async (): Promise<DockerInspect | null> => {
      const res = await requestWithRateLimitRetry({ method: "GET", path: `/containers/${nameSegment(name)}/json` });
      if (res.status === 404) return null;
      if (res.status >= 400) throw describeFailure(`docker inspect ${name}`, res);
      return JSON.parse(res.body.toString("utf8")) as DockerInspect;
    })();
    inspectInFlight.set(name, read);
    try {
      return await read;
    } finally {
      inspectInFlight.delete(name);
    }
  }

  async function requestJson<T>(opts: { method: string; path: string; body?: unknown; timeoutMs?: number }): Promise<T> {
    const res = await requestWithRateLimitRetry({
      method: opts.method,
      path: opts.path,
      body: opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body), "utf8"),
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      timeoutMs: opts.timeoutMs,
    });
    if (res.status >= 400) throw describeFailure(`docker API ${opts.method} ${opts.path}`, res);
    if (res.body.length === 0) return undefined as T;
    return JSON.parse(res.body.toString("utf8")) as T;
  }

  async function createNamed(name: string, body: unknown): Promise<void> {
    await requestJson({ method: "POST", path: `/containers/create?name=${encodeURIComponent(name)}`, body });
  }

  async function startByName(name: string): Promise<void> {
    const res = await requestWithRateLimitRetry({ method: "POST", path: `/containers/${nameSegment(name)}/start` });
    if (res.status >= 400) throw describeFailure(`docker start ${name}`, res);
  }

  async function stopByName(name: string): Promise<void> {
    const res = await requestWithRateLimitRetry({
      method: "POST",
      path: `/containers/${nameSegment(name)}/stop?t=${BOT_STOP_TIMEOUT_SEC}`,
      timeoutMs: (BOT_STOP_TIMEOUT_SEC + 30) * 1000,
    });
    if (res.status >= 400 && res.status !== 404) throw describeFailure(`docker stop ${name}`, res);
  }

  /** Removes a container and its anonymous volumes (`v=true` never touches a
   *  bind mount). Only ever called on a helper, a stale replacement, or a bot
   *  container that has already been stopped gracefully. */
  async function removeByName(name: string): Promise<void> {
    const res = await requestWithRateLimitRetry({ method: "DELETE", path: `/containers/${nameSegment(name)}?force=true&v=true` });
    if (res.status >= 400 && res.status !== 404) throw describeFailure(`docker remove ${name}`, res);
  }

  /** The image must be on the host (the driver never pulls) and declare a
   *  supported bot runtime contract (template.ts BOT_RUNTIME_CONTRACT_LABEL).
   *  Returns the VOLUME LAYOUT the contract pins — "legacy" (three separate
   *  binds) or "single" (one /bot) — so every caller builds its create body,
   *  drift expectation and helper plan for the layout THIS image boots from
   *  (the 1.6.5-rc.1 defect: a body of the new scheme under an old image).
   *  Throws on an unknown contract, before anything is created. */
  async function requireBotImage(image: string, layout: ScopeLayout = ISOLATED_LAYOUT): Promise<BotVolumeLayout> {
    const res = await requestWithRateLimitRetry({ method: "GET", path: `/images/${nameSegment(image)}/json` });
    if (res.status === 404) {
      throw new Error(`image "${image}" is not present on the Docker host; build or pull it first (the driver never pulls)`);
    }
    if (res.status >= 400) throw describeFailure(`docker image inspect ${image}`, res);
    let labels: Record<string, string> | null | undefined;
    try {
      labels = (JSON.parse(res.body.toString("utf8")) as { Config?: { Labels?: Record<string, string> | null } }).Config?.Labels;
    } catch {
      labels = undefined;
    }
    assertBotRuntimeContract(image, labels);
    // myrmidon(BOT-DISK-F): a member of a shared scope instance needs an image that
    // makes its own /data links at start; an older image would fail to start.
    if (layout.kind === "shared" && labels?.[BOT_RUNTIME_SCOPE_LABEL] !== "1") {
      throw new BotContainerTemplateError(
        `image "${image}" does not declare ${BOT_RUNTIME_SCOPE_LABEL}=1, so it cannot run as a member of a shared scope instance; rebuild the bot image`,
      );
    }
    return botVolumeLayout(image, labels);
  }

  async function putArchive(containerName: string, mountPath: string, archive: Buffer): Promise<void> {
    const res = await requestWithRateLimitRetry({
      method: "PUT",
      path: `/containers/${nameSegment(containerName)}/archive?path=${encodeURIComponent(mountPath)}&noOverwriteDirNonDir=true`,
      body: archive,
      headers: { "Content-Type": "application/x-tar" },
    });
    if (res.status >= 400) throw describeFailure(`docker archive PUT to ${containerName}:${mountPath}`, res);
  }

  async function helperLogs(name: string): Promise<string> {
    try {
      const res = await requestWithRateLimitRetry({ method: "GET", path: `/containers/${nameSegment(name)}/logs?stdout=true&stderr=true&tail=20` });
      if (res.status >= 400) return "";
      return demuxDockerLogs(res.body).trim().slice(-500);
    } catch {
      return "";
    }
  }

  /** Runs one helper container to completion and removes it. */
  async function runHelper(
    botKey: string,
    params: { image: string; role: HelperRole; script: string; archives?: readonly ProfileArchive[]; layout?: ScopeLayout },
  ): Promise<void> {
    const name = helperContainerNameFor(botKey);
    await removeByName(name); // a helper left over from an interrupted earlier run
    const body = buildHelperContainerRequestBody({
      botKey,
      image: params.image,
      role: params.role,
      script: params.script,
      volumeRoot: config.volumeRoot,
      scope: scopeMountOf(params.layout ?? ISOLATED_LAYOUT),
    });
    await createNamed(name, body);
    try {
      for (const archive of params.archives ?? []) {
        await putArchive(name, archive.mountPath, buildUstarArchive(archive.entries));
      }
      await startByName(name);
      const result = await requestJson<{ StatusCode?: number }>({
        method: "POST",
        path: `/containers/${nameSegment(name)}/wait?condition=not-running`,
        timeoutMs: HELPER_WAIT_TIMEOUT_MS,
      });
      if (result?.StatusCode !== 0) {
        const logs = await helperLogs(name);
        throw new Error(
          `${params.role} helper for ${containerNameFor(botKey)} exited with ${result?.StatusCode ?? "unknown status"}${logs ? `: ${logs}` : ""}`,
        );
      }
    } finally {
      await removeByName(name).catch(() => undefined);
    }
  }

  /** myrmidon(1.6.1-BOT-DISK-D): best-effort host side of the shared mount (the
   *  directory, and the move of an old per-bot "shared" copy into it). Never
   *  throws: Docker creates a missing bind source itself, and a failed migration
   *  leaves the bot's files where they are. */
  async function prepareSharedMountForBot(spec: BotContainerSpec): Promise<void> {
    const mount = resolveSpecSharedMount(spec, config.volumeRoot);
    if (!mount) return;
    const result = await prepareBotSharedMount(`${config.volumeRoot}/${spec.botKey}`, mount);
    for (const warning of result.warnings) {
      logger.warn({ botKey: spec.botKey, warning }, "bot shared mount: preparation warning");
    }
  }

  async function prepareVolumes(botKey: string, image: string, layout: ScopeLayout = ISOLATED_LAYOUT): Promise<void> {
    await runHelper(botKey, {
      image,
      role: "prepare-volumes",
      script: buildPrepareVolumesScript({ scope: layout.kind === "shared" }),
      layout,
    });
  }

  async function readAppliedMarker(botKey: string, known?: Pick<DockerInspect, "HostConfig">): Promise<AppliedMarker | null> {
    const name = containerNameFor(botKey);
    // The marker lives at its real path inside the container's one mount: /bot, or
    // /bot-scope/<botKey> for a member (read off the live container's binds).
    const info = known ?? (await inspectByName(name));
    if (!info) return null;
    const markerPath = `${botRealRootFromBinds(info.HostConfig?.Binds, botKey)}/hermes/${MARKER_RELATIVE_PATH}`;
    const res = await requestWithRateLimitRetry({
      method: "GET",
      path: `/containers/${nameSegment(name)}/archive?path=${encodeURIComponent(markerPath)}`,
    });
    if (res.status === 404) return null;
    // Any other failure is an error of this pass, not "nothing applied": guessing
    // either way would mean a needless drain-and-restart or a skipped update.
    if (res.status >= 400) throw describeFailure(`reading the applied-state marker of ${name}`, res);
    try {
      const file = parseUstarArchive(res.body).find((entry) => entry.type === "file");
      return file ? parseAppliedMarker(file.content.toString("utf8")) : null;
    } catch {
      return null; // corrupt marker: nothing verified applied
    }
  }

  async function readCloneReport(botKey: string): Promise<string | null> {
    const name = containerNameFor(botKey);
    try {
      const info = await inspectByName(name);
      if (!info) return null;
      const root = botRealRootFromBinds(info.HostConfig?.Binds, botKey);
      const res = await requestWithRateLimitRetry({
        method: "GET",
        path: `/containers/${nameSegment(name)}/archive?path=${encodeURIComponent(`${root}/hermes/${CLONE_HYGIENE_REPORT_PATH}`)}`,
      });
      if (res.status >= 400) return null;
      const file = parseUstarArchive(res.body).find((entry) => entry.type === "file");
      return file ? file.content.toString("utf8") : null;
    } catch {
      return null;
    }
  }

  async function status(botKey: string): Promise<BotContainerStatus> {
    const name = containerNameFor(botKey);
    const info = await inspectByName(name);
    if (!info) return { botKey, state: "missing" };
    const marker = await readAppliedMarker(botKey, info);
    return {
      botKey,
      state: botStateFromInspect(info),
      image: info.Config?.Image,
      restartHash: marker?.restartHash,
      filesHash: marker?.filesHash,
      maxConcurrentRuns: marker?.maxConcurrentRuns,
      // myrmidon(OPE-4789): the raw inspect rides along, so a caller that
      // already asked for the status (the reconciler, once per bot per pass)
      // can hand it to templateDrift instead of paying a second inspect.
      inspect: info,
    };
  }

  /** The containers of the given bots that exist. Asked per bot (inspect + marker),
   *  never by listing containers: dockergate keeps `containers/json` on its closed
   *  list, so a listing answers 403 on every sweep. */
  async function list(botKeys: readonly string[]): Promise<BotContainerStatus[]> {
    const results: BotContainerStatus[] = [];
    for (const botKey of new Set(botKeys)) {
      if (!BOT_KEY_PATTERN.test(botKey)) continue;
      const found = await status(botKey);
      if (found.state !== "missing") results.push(found);
    }
    return results;
  }

  /** The containers of the given bots that exist AND are running. Same per-bot
   *  reads as `list` (dockergate has no filtered listing), but stopped and
   *  unhealthy bots are left out — the clone-report collector's question
   *  (myrmidon(OPE-4789)), which must not wake a stopped bot's inspect+marker
   *  pair on every pass. */
  async function listRunning(botKeys: readonly string[]): Promise<BotContainerStatus[]> {
    const bots = await list(botKeys);
    return bots.filter((bot) => bot.state === "running");
  }

  async function templateDriftOf(existing: DockerInspect, spec: BotContainerSpec): Promise<TemplateDriftReport> {
    // The expectation the live container is compared against must be built for
    // the layout THIS image boots from (its contract, read off the host labels)
    // — comparing a 1.6.4 container against a single-mount body is exactly the
    // phantom drift that recreated 12 bots under a layout their image cannot
    // start with (1.6.5-rc.1). An image the host does not have or with an
    // unknown contract fails here, the same way create/recreate would, and the
    // reconciler logs the error instead of acting on a guess.
    const layout = await readScopeLayout(spec.botKey);
    const volumeLayout = await requireBotImage(spec.image, layout);
    const body = await createBody(spec, layout, volumeLayout);
    const fields = templateDriftFields(existing, body);
    return { drifted: fields.length > 0, fields };
  }

  async function templateDrift(spec: BotContainerSpec, knownStatus?: BotContainerStatus): Promise<TemplateDriftReport> {
    // myrmidon(OPE-4789): a caller that has just read the bot's status (the
    // reconciler, once per bot per pass) hands it in; its inspect is the same
    // answer a fresh inspectByName would give, so the drift check pays no
    // second inspect. A missing container has no template to drift from.
    if (knownStatus?.state === "missing") return { drifted: false, fields: [] };
    const existing = (knownStatus?.inspect as DockerInspect | undefined) ?? (await inspectByName(containerNameFor(spec.botKey)));
    if (!existing) return { drifted: false, fields: [] };
    return templateDriftOf(existing, spec);
  }

  /** myrmidon(1.6.5-DOCKERGATE-A2A3-STORM): status and drift from ONE inspect
   *  (A2) plus the marker read (A3): two gate requests per bot per pass. The
   *  status carries its own inspect (OPE-4789), which the drift check reuses. */
  async function statusWithDrift(spec: BotContainerSpec): Promise<{ status: BotContainerStatus; drift: TemplateDriftReport }> {
    const current = await status(spec.botKey);
    return { status: current, drift: await templateDrift(spec, current) };
  }

  async function create(spec: BotContainerSpec): Promise<void> {
    const layout = await readScopeLayout(spec.botKey);
    const volumeLayout = await requireBotImage(spec.image, layout);
    const body = await createBody(spec, layout, volumeLayout);
    await removeByName(replacementContainerNameFor(spec.botKey)); // stale, from an interrupted recreate
    await prepareVolumes(spec.botKey, spec.image, layout);
    await prepareSharedMountForBot(spec);
    await createNamed(containerNameFor(spec.botKey), body);
  }

  async function recreate(spec: BotContainerSpec): Promise<void> {
    const layout = await readScopeLayout(spec.botKey);
    const name = containerNameFor(spec.botKey);
    const replacement = replacementContainerNameFor(spec.botKey);
    // Everything that can fail for a reason of its own (missing image, rejected
    // template, daemon refusing the create, a disk migration that would conflict)
    // happens while the old container is still intact. The image check also
    // decides the VOLUME LAYOUT the replacement body is built with: an old card
    // keeps being recreated under the layout its own image understands.
    const volumeLayout = await requireBotImage(spec.image, layout);
    const body = await createBody(spec, layout, volumeLayout);
    const existing = await inspectByName(name);
    const from = existing ? layoutOfInspect(existing) : layout;
    const moves = scopeLayoutKeyOf(from) !== scopeLayoutKeyOf(layout);
    if (moves) {
      if (!options.scopeMigration) {
        throw new BotContainerTemplateError(
          `${name} changes isolation scope (${scopeLayoutKeyOf(from)} -> ${scopeLayoutKeyOf(layout)}) but no disk migration is configured; nothing was changed`,
        );
      }
      await options.scopeMigration.check({ botKey: spec.botKey, from, to: layout });
    }
    await removeByName(replacement);
    // Everything the gate or the daemon may refuse (the volumes of the new layout, the
    // replacement itself) is done while the old container still runs, so a refusal leaves
    // the bot untouched. The new layout's directories exist, empty, by then; the migration
    // renames the old ones onto them.
    await prepareVolumes(spec.botKey, spec.image, layout);
    await prepareSharedMountForBot(spec);
    await createNamed(replacement, body);
    if (moves) {
      // Pause: the old container stops first so nothing writes while its directories move.
      // The agent is already drained (the reconciler's maintenance window). A failed move
      // is undone by the migration itself; the old container is then started again.
      await stopByName(name);
      try {
        await options.scopeMigration!.run({ botKey: spec.botKey, from, to: layout });
      } catch (err) {
        await startByName(name).catch(() => undefined);
        throw err;
      }
    }
    // Only now touch the old one: SIGTERM, SIGKILL after BOT_STOP_TIMEOUT_SEC.
    await stopByName(name);
    await removeByName(name);
    const res = await requestWithRateLimitRetry({
      method: "POST",
      path: `/containers/${nameSegment(replacement)}/rename?name=${encodeURIComponent(name)}`,
    });
    if (res.status >= 400) throw describeFailure(`docker rename ${replacement} -> ${name}`, res);
  }

  async function writeProfile(botKey: string, profile: CompiledProfile): Promise<void> {
    const name = containerNameFor(botKey);
    if (profile.botKey !== botKey) {
      throw new BotContainerTemplateError(`profile for "${profile.botKey}" cannot be written to bot "${botKey}"`);
    }
    const info = await inspectByName(name);
    if (!info) throw new Error(`${name} does not exist; create it before writing its profile`);
    const previous = await readAppliedMarker(botKey, info);
    const nonce = newNonce();
    const archives = buildProfileArchives(profile, { nonce, removals: computeProfileRemovals(previous?.files, profile) });
    // The helper works in the live container's layout (its binds), not the pending one.
    await runHelper(botKey, { image: info.Image, role: "apply-profile", script: buildApplyScript(nonce), archives, layout: layoutOfInspect(info) });
  }

  async function waitForHealthy(botKey: string): Promise<void> {
    const name = containerNameFor(botKey);
    const deadline = clock() + startHealthTimeoutMs;
    for (;;) {
      const info = await inspectByName(name);
      if (!info) throw new Error(`${name} disappeared while waiting for it to become healthy`);
      const state = info.State?.Status ?? "unknown";
      const health = info.State?.Health?.Status;
      if (state === "running" && (health === undefined || health === "healthy")) return;
      if (state === "running" && health === "unhealthy") throw new Error(`${name} reports unhealthy after start`);
      if (state === "exited" || state === "dead") {
        throw new Error(`${name} ${state} (exit code ${info.State?.ExitCode ?? "unknown"}) instead of becoming healthy`);
      }
      if (clock() >= deadline) {
        throw new Error(
          `${name} did not become healthy within ${startHealthTimeoutMs}ms (last state: ${health ? `${state}/${health}` : state})`,
        );
      }
      await sleep(healthPollIntervalMs);
    }
  }

  async function start(botKey: string): Promise<void> {
    await startByName(containerNameFor(botKey)); // 304 (already running) is not an error
    await waitForHealthy(botKey);
  }

  async function restart(botKey: string): Promise<void> {
    const name = containerNameFor(botKey);
    const res = await requestWithRateLimitRetry({
      method: "POST",
      path: `/containers/${nameSegment(name)}/restart?t=${BOT_STOP_TIMEOUT_SEC}`,
      timeoutMs: (BOT_STOP_TIMEOUT_SEC + 30) * 1000,
    });
    if (res.status >= 400) throw describeFailure(`docker restart ${name}`, res);
    await waitForHealthy(botKey);
  }

  async function stop(botKey: string): Promise<void> {
    await stopByName(containerNameFor(botKey));
  }

  return { status, list, listRunning, templateDrift, statusWithDrift, create, recreate, writeProfile, start, restart, stop, readCloneReport };
}
