import { describe, expect, it } from "vitest";
import { colors, contrastPairs, contrastRatio, buildCss } from "./index.js";

describe("token contrast (WCAG AA)", () => {
  for (const mode of ["light", "dark"] as const) {
    for (const [fg, bg, min] of contrastPairs) {
      it(`${mode}: ${fg} on ${bg} is at least ${min}:1`, () => {
        const ratio = contrastRatio(colors[mode][fg], colors[mode][bg]);
        expect(ratio).toBeGreaterThanOrEqual(min);
      });
    }
  }

  it("matches the accent values chosen in the architecture plan", () => {
    expect(colors.light.accent).toBe("#0066CC");
    expect(colors.dark.accent).toBe("#4DA3FF");
    expect(contrastRatio("#0066CC", "#FFFFFF")).toBeCloseTo(5.57, 1);
  });

  it("light and dark define the same token names", () => {
    expect(Object.keys(colors.dark).sort()).toEqual(Object.keys(colors.light).sort());
  });

  it("builds CSS with both modes", () => {
    const css = buildCss();
    expect(css).toContain("--accent: #0066CC;");
    expect(css).toContain("--accent: #4DA3FF;");
    expect(css).toContain("prefers-color-scheme: dark");
  });
});
