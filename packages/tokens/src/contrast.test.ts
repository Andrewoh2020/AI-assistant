import { describe, expect, it } from "vitest";
import { colors, contrastPairs, contrastRatio, buildCss } from "./index.js";

describe("token contrast (WCAG AA)", () => {
  // Light only: dark mode isn't shipped yet. Add "dark" back here when it is.
  for (const mode of ["light"] as const) {
    for (const [fg, bg, min] of contrastPairs) {
      it(`${mode}: ${fg} on ${bg} is at least ${min}:1`, () => {
        const ratio = contrastRatio(colors[mode][fg], colors[mode][bg]);
        expect(ratio).toBeGreaterThanOrEqual(min);
      });
    }
  }

  it("matches the colors measured from the Muse app", () => {
    expect(colors.light.bg).toBe("#FCFCFC");
    expect(colors.light.bubble).toBe("#E9EAEB");
    expect(colors.light.bubbleUser).toBe("#BFDAFB");
    expect(colors.light.ink).toBe("#111112");
    expect(colors.light.accent).toBe("#2962CD");
    expect(contrastRatio("#0066CC", "#FFFFFF")).toBeCloseTo(5.57, 1);
  });

  it("light and dark define the same token names", () => {
    expect(Object.keys(colors.dark).sort()).toEqual(Object.keys(colors.light).sort());
  });

  it("builds light-only CSS for now", () => {
    const css = buildCss();
    expect(css).toContain("--accent: #2962CD;");
    expect(css).toContain("--bubble-user: #BFDAFB;");
    expect(css).not.toContain("prefers-color-scheme: dark");
    expect(css).not.toContain(colors.dark.bg);
  });
});
