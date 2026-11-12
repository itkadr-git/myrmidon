// myrmidon(fleet-site audit): the list of secret profile files (profile-files.ts) follows the compiler.
//
// The replica store leaves these files out of a stored snapshot and relies on the apply that follows
// a restore to write them again. If the compiler starts to write another file as a secret, or
// renames one, this test fails until the list is changed with it.

import { describe, expect, it } from "vitest";
import { compileHermesProfile, type HermesProfileInput } from "./profile-compiler.js";
import { HERMES_CONFIG_FILE, HERMES_ENV_FILE, PROFILE_SECRET_FILE_PATHS } from "./profile-files.js";

// Everything here is placeholder data: fake bot keys, example.com URLs and obviously-fake secrets.
function input(overrides: Partial<HermesProfileInput> = {}): HermesProfileInput {
  return {
    botKey: "agent-a",
    adapterConfig: {},
    env: {},
    skills: {},
    instructions: "# Role\n\nYou are agent-a.\n",
    hindsight: { bankId: "agent-a", apiUrl: "https://example.com/hindsight" },
    llm: {},
    mcpServers: [],
    maxConcurrentRuns: 2,
    instanceDefaults: {},
    apiServerKey: "fake-api-server-key-0001",
    paperclipApiUrl: "https://example.com",
    paperclipApiKey: "fake-paperclip-api-key-0001",
    ...overrides,
  };
}

const withHeaders = input({
  mcpServers: [{ name: "board", url: "https://example.com/mcp/board", headers: { Authorization: "Bearer fake-token" } }],
});
const withEnvSecret = input({ env: { SOME_TOKEN: { value: "fake-value", secret: true }, PLAIN: { value: "x", secret: false } } });
const withSkills = input({ skills: { review: [{ path: "SKILL.md", content: "# Review\n" }] } });

describe("profile secret files", () => {
  it("every file the compiler writes as a secret is in the list the replica store leaves out", () => {
    for (const source of [input(), withHeaders, withEnvSecret, withSkills]) {
      for (const file of compileHermesProfile(source).files) {
        if (file.secret) expect(PROFILE_SECRET_FILE_PATHS).toContain(file.path);
        if (file.mode === 0o600) expect(PROFILE_SECRET_FILE_PATHS).toContain(file.path);
      }
    }
  });

  it("the files in the list are the ones the compiler writes, under the same names", () => {
    const paths = compileHermesProfile(withHeaders).files.map((f) => f.path);
    for (const path of PROFILE_SECRET_FILE_PATHS) expect(paths).toContain(path);
    expect(PROFILE_SECRET_FILE_PATHS).toEqual([HERMES_ENV_FILE, HERMES_CONFIG_FILE]);
    expect(HERMES_ENV_FILE).toBe("hermes/.env");
    expect(HERMES_CONFIG_FILE).toBe("hermes/config.yaml");
  });

  it("the env file is always secret, the config file when an MCP server carries headers", () => {
    const secretPaths = (source: HermesProfileInput) =>
      compileHermesProfile(source).files.filter((f) => f.secret).map((f) => f.path).sort();
    expect(secretPaths(input())).toEqual([HERMES_ENV_FILE]);
    expect(secretPaths(withHeaders)).toEqual([HERMES_CONFIG_FILE, HERMES_ENV_FILE].sort());
  });
});
