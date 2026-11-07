// myrmidon(1.7 SETTINGS-TO-UI D): the registered defaults keep today's behavior.
import { describe, expect, it } from "vitest";
import { behaviorSettingRegistry, resolveSetting } from "@myrmidon/shared";

describe("myrmidon(1.7 SETTINGS-TO-UI D) defaults without settings", () => {
  it("auxiliary models default to null, a saved empty value is kept and means unset", () => {
    for (const key of ["botAuxTitleModel", "botAuxCompressionModel"]) {
      expect(resolveSetting({ key, env: {} })).toEqual({ value: null, source: "default" });
      expect(resolveSetting({ key, stored: "", env: {} })).toEqual({ value: "", source: "ui" });
    }
  });

  it("attachment ceilings default to 10 MB and the environment still overrides", () => {
    for (const key of ["paperclipAttachmentMaxBytes", "telegramFileLimitBytes"]) {
      expect(resolveSetting({ key, env: {} }).value).toBe(10 * 1024 * 1024);
    }
    const def = behaviorSettingRegistry.get("paperclipAttachmentMaxBytes")!;
    expect(resolveSetting({ key: "paperclipAttachmentMaxBytes", env: { [def.envName]: "5" } })).toEqual({
      value: 5,
      source: "env",
    });
  });

  it("the cost sweep default is 300 s and context lengths travel as json", () => {
    expect(resolveSetting({ key: "litellmCostIntervalSec", env: {} }).value).toBe(300);
    expect(behaviorSettingRegistry.get("botModelContextLengths")!.valueType).toBe("json");
  });
});
