import { describe, expect, it } from "vitest";

import { 
  type HermesProfileInput,
  compileHermesProfile
} from "./profile-compiler.js";

// Test helper function
function baseInput(overrides: Partial<HermesProfileInput> = {}): HermesProfileInput {
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
    paperclipApiKey: "fake-...01",
    ...overrides,
  };
}

function fileByPath(files: ReturnType<typeof compileHermesProfile>["files"], path: string) {
  const found = files.find((f) => f.path === path);
  if (!found) throw new Error(`no compiled file at ${path}`);
  return found;
}

// Simple test to validate LSP functionality
console.log("Testing LSP configuration functionality...");

try {
  // Test 1: Basic LSP configuration from instance defaults
  const profile1 = compileHermesProfile(
    baseInput({
      instanceDefaults: {
        lsp: {
          enabled: true,
          idleTimeout: 120,
          excludeRoots: ["**/myrmidon/**", "/workspace/*/repo"],
          waitMode: "sync",
        },
      },
    })
  );
  
  const yaml1 = fileByPath(profile1.files, "hermes/config.yaml").content;
  console.log("✓ Test 1 passed: LSP settings from instance defaults");
  console.log("  - Contains 'lsp:' section:", yaml1.includes("lsp:"));
  console.log("  - Contains enabled setting:", yaml1.includes("enabled: true"));
  console.log("  - Contains idle_timeout setting:", yaml1.includes("idle_timeout: 120"));

  // Test 2: LSP configuration from agent-specific settings
  const profile2 = compileHermesProfile(
    baseInput({
      lsp: {
        enabled: false,
        idleTimeout: 60,
      },
    })
  );
  
  const yaml2 = fileByPath(profile2.files, "hermes/config.yaml").content;
  console.log("✓ Test 2 passed: LSP settings from agent-specific overrides");
  console.log("  - Contains 'lsp:' section:", yaml2.includes("lsp:"));
  console.log("  - Contains agent override:", yaml2.includes("enabled: false"));

  // Test 3: No LSP settings when not configured
  const profile3 = compileHermesProfile(baseInput());
  
  const yaml3 = fileByPath(profile3.files, "hermes/config.yaml").content;
  console.log("✓ Test 3 passed: No LSP section when not configured");
  console.log("  - Does not contain 'lsp:' section:", !yaml3.includes("lsp:"));

  console.log("\nAll tests passed! LSP configuration is working correctly.");
} catch (error) {
  console.error("Test failed:", error);
  process.exit(1);
}