import { describe, expect, it } from \"vitest\";
import {
  detectModelFamily,
  getModelInstructionProfile,
  renderModelInstructionSection,
  COMMON_FALLBACK_DIRECTIVES,
  GLM_DIRECTIVES,
  GPT_DIRECTIVES,
  CLAUDE_DIRECTIVES,
} from \"./model-instruction-profiles.js\";

describe(\"Model Instruction Profiles\", () => {
  describe(\"detectModelFamily\", () => {
    it(\"detects GLM family models and providers\", () => {
      expect(detectModelFamily(\"glm-4\")).toBe(\"glm\");
      expect(detectModelFamily(\"glm-5.3\")).toBe(\"glm\");
      expect(detectModelFamily(\"dashscope/glm-4-plus\")).toBe(\"glm\");
      expect(detectModelFamily(\"chatglm-pro\")).toBe(\"glm\");
      expect(detectModelFamily(\"custom-model\", \"dashscope\")).toBe(\"glm\");
      expect(detectModelFamily(\"custom-model\", \"zai\")).toBe(\"glm\");
    });

    it(\"detects GPT family models and providers\", () => {
      expect(detectModelFamily(\"gpt-4o\")).toBe(\"gpt\");
      expect(detectModelFamily(\"gpt-5.4\")).toBe(\"gpt\");
      expect(detectModelFamily(\"o1-preview\")).toBe(\"gpt\");
      expect(detectModelFamily(\"o3-mini\")).toBe(\"gpt\");
      expect(detectModelFamily(\"openai/gpt-4.5\")).toBe(\"gpt\");
      expect(detectModelFamily(\"custom-model\", \"openai\")).toBe(\"gpt\");
      expect(detectModelFamily(\"custom-model\", \"copilot\")).toBe(\"gpt\");
    });

    it(\"detects Claude family models and providers\", () => {
      expect(detectModelFamily(\"claude-3-5-sonnet\")).toBe(\"claude\");
      expect(detectModelFamily(\"claude-3-7-sonnet\")).toBe(\"claude\");
      expect(detectModelFamily(\"anthropic/claude-sonnet-4\")).toBe(\"claude\");
      expect(detectModelFamily(\"claude-opus-3\")).toBe(\"claude\");
      expect(detectModelFamily(\"claude-haiku-3.5\")).toBe(\"claude\");
      expect(detectModelFamily(\"custom-model\", \"anthropic\")).toBe(\"claude\");
    });

    it(\"falls back to fallback family for unknown or missing models\", () => {
      expect(detectModelFamily(undefined)).toBe(\"fallback\");
      expect(detectModelFamily(\"\")).toBe(\"fallback\");
      expect(detectModelFamily(\"deepseek-chat\")).toBe(\"fallback\");
      expect(detectModelFamily(\"llama-3-70b\", \"groq\")).toBe(\"fallback\");
    });
  });

  describe(\"getModelInstructionProfile\", () => {
    it(\"returns GLM profile with specific JSON and anti-loop directives\", () => {
      const profile = getModelInstructionProfile(\"glm-5.3\");
      expect(profile.family).toBe(\"glm\");
      expect(profile.name).toContain(\"GLM\");
      for (const d of COMMON_FALLBACK_DIRECTIVES) {
        expect(profile.directives).toContain(d);
      }
      for (const d of GLM_DIRECTIVES) {
        expect(profile.directives).toContain(d);
      }
      expect(profile.directives.some((d) => d.includes(\"JSON\"))).toBe(true);
    });

    it(\"returns GPT profile with direct action directives\", () => {
      const profile = getModelInstructionProfile(\"gpt-4o\");
      expect(profile.family).toBe(\"gpt\");
      expect(profile.name).toContain(\"GPT\");
      for (const d of GPT_DIRECTIVES) {
        expect(profile.directives).toContain(d);
      }
      expect(profile.directives.some((d) => d.includes(\"Direct action\"))).toBe(true);
    });

    it(\"returns Claude profile with context anchoring directives\", () => {
      const profile = getModelInstructionProfile(\"claude-3-7-sonnet\");
      expect(profile.family).toBe(\"claude\");
      expect(profile.name).toContain(\"Claude\");
      for (const d of CLAUDE_DIRECTIVES) {
        expect(profile.directives).toContain(d);
      }
      expect(profile.directives.some((d) => d.includes(\"Patch context anchoring\"))).toBe(true);
    });

    it(\"returns Fallback profile for unknown models\", () => {
      const profile = getModelInstructionProfile(\"unknown-llm\");
      expect(profile.family).toBe(\"fallback\");
      expect(profile.directives).toEqual([...COMMON_FALLBACK_DIRECTIVES]);
    });
  });

  describe(\"renderModelInstructionSection\", () => {
    it(\"renders formatted markdown directives section\", () => {
      const section = renderModelInstructionSection(\"glm-5.3\", \"dashscope\");
      expect(section).toContain(\"# Model Operational Directives (GLM Family Instruction Profile)\");
      expect(section).toContain(\"Family: glm (model: glm-5.3)\");
      expect(section).toContain(\"- Strict JSON parameters\");
      expect(section).toContain(\"- Operational hygiene: Always construct and use absolute file paths\");
    });
  });
});
