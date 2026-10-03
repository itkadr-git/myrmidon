// server/src/myrmidon/bot-containers/driver.ts
//
// Backend-agnostic contract for bringing up and updating a bot's gateway container.
// The pilot implements it with a local Docker Engine client (docker-driver.ts) that
// talks to the same host the board runs on. The eventual `fleetd` service
// (containers-plan-senior-2026-09-28.md §1.4) is meant to implement this same
// interface over its own small HTTP API, so reconciler.ts does not change when that
// move happens — only which driver gets constructed in index.ts does.
//
// Nothing here starts a container implicitly: `create` and `recreate` leave the
// container created-but-stopped, so the reconciler can lay the profile down first
// and only then `start` it. A gateway therefore never boots without its profile.

import type { CompiledProfile } from "./types.js";

/** One extra read-only mount a bot gets from the instance-level allowlist
 *  (`MYRMIDON_BOT_MOUNT_SOURCES`, template.ts). Read-only only: a shared
 *  directory is never mounted writable, and the driver refuses a mount whose
 *  source the operator did not list. (The shared package cache of
 *  1.6.1-BOT-DISK-B is not a card mount: the local driver adds it itself from
 *  the instance settings; a fleetd host does not get it, see fleetd-driver.ts.) */
export interface BotExtraMount {
  /** Absolute host directory, listed in MYRMIDON_BOT_MOUNT_SOURCES. */
  source: string;
  /** Absolute mount point inside the container, outside the three fixed ones. */
  containerPath: string;
  /** Always true: a writable extra mount is not supported. */
  readOnly: true;
}

/** Desired shape of a bot's container. Immutable for the life of the container:
 *  a change is a template drift (`templateDrift`), applied by `recreate`. */
export interface BotContainerSpec {
  /** [a-z0-9-], validated by the driver. Also the container's name and its DNS name
   *  on the bot network (`myrmidon-bot-<botKey>`). */
  botKey: string;
  /** Must match an entry in the driver's image allowlist. */
  image: string;
  memoryMb: number;
  cpus: number;
  pidsLimit: number;
  /** Docker network the container joins. The local driver requires this to equal
   *  its own MYRMIDON_BOT_NETWORK; a caller cannot put a bot on an arbitrary network. */
  network: string;
  /** Extra read-only mounts (the card's `container.extraMounts`). Their sources
   *  are checked against MYRMIDON_BOT_MOUNT_SOURCES when the create body is
   *  built; a mount outside that list is refused, not silently dropped. */
  extraMounts?: readonly BotExtraMount[];
  /** Whether this bot should have access to the shared directory */
  hasSharedMountAccess?: boolean;
  /** Extra, non-authoritative labels (e.g. a project grouping). The driver's own
   *  identification labels (see template.ts BOT_LABEL_KEYS) always win on
   *  conflict and cannot be overridden through this field. */
  labels?: Record<string, string>;
}

/**
 * - `running`: the container is up and its health check (if the image has one)
 *   does not report it unhealthy.
 * - `unhealthy`: the container is up but its own health check has failed
 *   repeatedly (Docker's `State.Health.Status === "unhealthy"`, i.e. the image's
 *   HEALTHCHECK retries were exhausted — not a single failed probe).
 * - `stopped`: exists but is not running (created, exited, restarting, dead).
 *   Nothing can be executing in it.
 * - `missing`: no container under this bot's name.
 */
export type BotContainerState = "running" | "stopped" | "missing" | "unhealthy";

export interface BotContainerStatus {
  botKey: string;
  state: BotContainerState;
  image?: string;
  /** Profile hashes the driver can confirm were fully applied on disk, read
   *  from the marker the last successful `writeProfile` moved into place as its
   *  final step. Absent when the container is missing, when nothing has been
   *  written yet, or when the marker is unreadable — "nothing verified applied",
   *  which classifyProfileChange (types.ts) turns into a "restart" class change,
   *  never "none". */
  restartHash?: string;
  filesHash?: string;
  /** myrmidon(CONCURRENCY-SYNC): gateway.api_server.max_concurrent_runs the applied
   *  profile carries, read from the same marker (docker-driver.ts AppliedMarker).
   *  Absent when nothing is verifiably applied, or when the marker predates the
   *  field — "not reported", which the card shows as unknown, never as a match. */
  maxConcurrentRuns?: number;
  /**
   * myrmidon(OPE-4789): the raw container inspect behind this status, when the
   * driver has it (the local docker driver always does — the status IS an
   * inspect). Lets a caller that already paid for one inspect hand it to
   * `templateDrift(spec, status)` instead of the pass paying a second one.
   * Never set by a driver that answers without inspecting (fleetd).
   */
  inspect?: unknown;
}

/** One template field whose live value (the container's inspect) no longer
 *  matches what a freshly built create body asks for. */
export interface TemplateDriftField {
  /** Dotted path of the field inside a container inspect, e.g.
   *  `HostConfig.Binds` — also the name the activity log carries, so a drift
   *  is diagnosable from the log alone. */
  field: string;
  /** Value the freshly built create body asks for. */
  expected: unknown;
  /** Value the live container shows. `undefined` when the inspect the driver
   *  reads does not report the field at all, which is a drift of that field. */
  actual: unknown;
}

/**
 * Result of the side-effect-free template check. `fields` names every field
 * that differs, with both values (the activity log writes them out); empty
 * `fields` means the live container still matches the spec.
 */
export interface TemplateDriftReport {
  drifted: boolean;
  fields: TemplateDriftField[];
}

export interface BotContainerDriver {
  /** Throws when the container runtime itself cannot be asked (socket error,
   *  unexpected API error) — never guesses a state. */
  status(botKey: string): Promise<BotContainerStatus>;
  /** The containers of the given bots that exist (a bot without a container is left
   *  out). The caller names the bots — the board knows them from the agent cards —
   *  because the container runtime is never asked to list its containers: the
   *  dockergate allowlist has no such call. */
  list(botKeys: readonly string[]): Promise<BotContainerStatus[]>;
  /**
   * myrmidon(OPE-4789): the containers of the given bots that exist AND are
   * running. Same per-bot reads as `list`; the clone-report collector asks
   * this instead, so a stopped bot's inspect+marker pair is not paid on every
   * collection pass. Optional: a driver that cannot answer it (fleetd) leaves
   * it out, and the collector then uses `list` and filters itself.
   */
  listRunning?(botKeys: readonly string[]): Promise<BotContainerStatus[]>;
  /**
   * Side-effect-free check: does the existing container's live template (image,
   * resource limits, network, bind list) no longer match `spec`? `drifted` is
   * false when no container exists; `fields` names every field that differs,
   * with the wanted and the live value, so the caller can log what drifted.
   * The reconciler applies a `drifted: true` with `recreate`, gated behind the
   * same maintenance-pause-and-drain flow as a profile "restart" class change
   * whenever the container is live.
   *
   * myrmidon(OPE-4789): `knownStatus` is a status the caller has just read for
   * this bot (the reconciler reads one at the top of every pass). When its
   * state is not "missing" the driver reuses the inspect it carries instead of
   * asking the runtime again — one inspect serves both the status and the
   * drift check of one pass.
   */
  templateDrift(spec: BotContainerSpec, knownStatus?: BotContainerStatus): Promise<TemplateDriftReport>;
  /** Creates the bot's container from `spec` without starting it, after
   *  preparing its volumes (created if absent, owned by the container's uid,
   *  mode 0700). Throws, before creating anything, if the image is not present
   *  locally or does not declare a supported bot runtime contract (the image
   *  label template.ts BOT_RUNTIME_CONTRACT_LABEL). */
  create(spec: BotContainerSpec): Promise<void>;
  /** Replaces a drifted container with one built from `spec`, left stopped.
   *  Checks the new image the same way as `create` and creates the
   *  replacement before the old container is touched, then stops the old one
   *  gracefully (never a bare force-kill) and swaps the replacement in under
   *  the bot's name. */
  recreate(spec: BotContainerSpec): Promise<void>;
  /** Lays the compiled profile's files down in the bot's volumes. Works whether
   *  the container is running or stopped (does not exec into it); the reconciler
   *  uses this alone for a "files" class change on a running container. Files an
   *  earlier apply wrote that this profile no longer has are removed, and
   *  compiler-owned directories (template.ts BOT_MANAGED_DIRS) are replaced
   *  wholesale. The applied-state marker is moved into place last. */
  writeProfile(botKey: string, profile: CompiledProfile): Promise<void>;
  /** Starts a stopped container. Resolves once it is running and healthy;
   *  throws otherwise. */
  start(botKey: string): Promise<void>;
  /** Gracefully restarts a running container so the gateway picks up files
   *  already written to disk. Resolves once healthy again; throws otherwise. */
  restart(botKey: string): Promise<void>;
  stop(botKey: string): Promise<void>;
  /**
   * myrmidon(1.6.2-BOT-DISK-C): the text of the bot's clone-hygiene report
   * (`$HERMES_HOME/.myrmidon/clone-hygiene.json`, written inside the container),
   * or null when there is none or it cannot be read. The board has no mount of the
   * bot volumes, so this is how it learns which clones hold unpushed work.
   * Optional: a driver that cannot read it (fleetd) leaves it out.
   */
  readCloneReport?(botKey: string): Promise<string | null>;
}
