import { describe, expect, it } from "vitest";
import viteConfigExport from "../../vite.config";

describe("ui/vite.config.ts minification and build options", () => {
  it("configures oxc minification in production build without esbuild drop block", () => {
    const config =
      typeof viteConfigExport === "function"
        ? viteConfigExport({ command: "build", mode: "production" })
        : viteConfigExport;

    // Must not retain legacy esbuild drop block
    expect(config.esbuild).toBeUndefined();

    // Production build uses oxc minifier
    expect(config.build?.minify).toBe("oxc");

    // Rolldown output minification settings drop console/debugger and legal comments
    const rolldownOptions = config.build?.rolldownOptions;
    const output = Array.isArray(rolldownOptions?.output)
      ? rolldownOptions.output[0]
      : rolldownOptions?.output;

    expect(output).toBeDefined();
    expect(output?.minify).toEqual({
      compress: expect.objectContaining({
        dropConsole: true,
        dropDebugger: true,
      }),
      codegen: expect.objectContaining({
        legalComments: "none",
      }),
    });
  });

  it("disables minification and does not drop console/debugger in development serve", () => {
    const config =
      typeof viteConfigExport === "function"
        ? viteConfigExport({ command: "serve", mode: "development" })
        : viteConfigExport;

    // No esbuild drop block in development
    expect(config.esbuild).toBeUndefined();

    // In development mode minify is false
    expect(config.build?.minify).toBe(false);

    // No production rolldown minify options in development
    const rolldownOptions = config.build?.rolldownOptions;
    const output = Array.isArray(rolldownOptions?.output)
      ? rolldownOptions.output[0]
      : rolldownOptions?.output;

    expect(output?.minify).toBeUndefined();
  });
});
