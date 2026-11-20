import { afterEach, describe, expect, it, vi } from "vitest";
import type * as JSDOMModule from "jsdom";

const safe = (label: string) => Buffer.from(`<html><head><style>.dot{opacity:.5}</style></head><body><svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="3"/></svg><div class="dot">${label}</div></body></html>`);

afterEach(() => {
  vi.doUnmock("jsdom");
  vi.resetModules();
});

describe("lazy announcement animation validation", () => {
  it("loads jsdom only on validation and closes each real window on success and rejection", async () => {
    vi.resetModules();
    const loaded = vi.fn();
    const closed = vi.fn();
    vi.doMock("jsdom", async (importOriginal) => {
      loaded();
      const original = await importOriginal<typeof JSDOMModule>();
      return {
        ...original,
        JSDOM: class extends original.JSDOM {
          constructor(...args: ConstructorParameters<typeof original.JSDOM>) {
            super(...args);
            const close = this.window.close.bind(this.window);
            this.window.close = () => { closed(); close(); };
          }
        },
      };
    });
    // Import after module reset to exercise the lazy-loading boundary.
    const { validateAnnouncementAnimation } = await import("../services/announcement-animation.js");
    expect(loaded).not.toHaveBeenCalled();
    const result = await validateAnnouncementAnimation(safe("first"));
    expect(loaded).toHaveBeenCalledOnce();
    expect(result).toContain(".dot{opacity:.5}");
    expect(result).toContain('<circle cx="5" cy="5" r="3"');
    expect(closed).toHaveBeenCalledTimes(1);
    await expect(validateAnnouncementAnimation(Buffer.from("<script>alert(1)</script>"))).rejects.toThrow();
    expect(closed).toHaveBeenCalledTimes(2);
  });

  it("rejects unsafe input without contaminating subsequent or concurrent files", async () => {
    // Import after module reset to exercise the lazy-loading boundary.
    const { validateAnnouncementAnimation } = await import("../services/announcement-animation.js");
    for (const input of ["<script>alert(1)</script>", "<svg onload='alert(1)'></svg>", "<a href='https://evil.test'>navigate</a>"]) {
      await expect(validateAnnouncementAnimation(Buffer.from(input))).rejects.toThrow();
      expect(await validateAnnouncementAnimation(safe("after rejection"))).toContain("after rejection");
    }
    await expect(validateAnnouncementAnimation(Buffer.from([0xff]))).rejects.toThrow();
    const [first, second] = await Promise.all([
      validateAnnouncementAnimation(safe("parallel first")),
      validateAnnouncementAnimation(safe("parallel second")),
    ]);
    expect(first).toContain("parallel first");
    expect(first).not.toContain("parallel second");
    expect(second).toContain("parallel second");
    expect(second).not.toContain("parallel first");
  });
});
