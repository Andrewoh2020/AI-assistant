/**
 * Design tokens for web and mobile, from Muse's Web & Mobile Design System
 * (sections 2-4, M3), with the blue accent chosen in the architecture plan, section 9.
 * One source: `scripts/build-css.mjs` turns this into CSS variables for the web app,
 * and the mobile app will import the same objects as a typed theme.
 */

export type Mode = "light" | "dark";

export const colors = {
  light: {
    bg: "#FAF9F7",
    surface: "#FFFFFF",
    surface2: "#F3F1EC",
    ink: "#1A1A18",
    ink2: "#5C5952",
    ink3: "#8A867D",
    line: "#E6E2D9",
    accent: "#0066CC",
    accentInk: "#FFFFFF",
    accentSoft: "#E8F1FB",
    success: "#18794E",
    successSoft: "#E6F4EC",
    // Muse lists #9A6A00, which is only 4.28:1 on warnSoft; darkened to pass AA.
    warn: "#8A5F00",
    warnSoft: "#FDF3D7",
    danger: "#C92A2A",
    dangerSoft: "#FDECEC",
  },
  dark: {
    bg: "#171715",
    surface: "#232320",
    surface2: "#2C2C28",
    ink: "#F2F0E9",
    ink2: "#C4C0B6",
    ink3: "#9A968C",
    line: "#3A3934",
    accent: "#4DA3FF",
    accentInk: "#0B1A2B",
    accentSoft: "#1A2C40",
    success: "#4CC38A",
    successSoft: "#16301F",
    warn: "#E0B341",
    warnSoft: "#33280F",
    danger: "#FF7B72",
    dangerSoft: "#3A1C1A",
  },
} as const;

export type ColorName = keyof (typeof colors)["light"];

export const radius = {
  web: { s: 8, m: 12, l: 18, pill: 999 },
  mobile: { s: 12, m: 16, l: 22, pill: 999 },
} as const;

export const space = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 24, 6: 32, 8: 48 } as const;

/** [size px, line-height, weight] */
export const type = {
  web: {
    display: [34, 1.15, 700],
    h1: [28, 1.2, 700],
    h2: [23, 1.3, 700],
    h3: [17, 1.4, 600],
    body: [16, 1.55, 400],
    small: [14, 1.5, 400],
    caption: [12, 1.4, 700],
  },
  mobile: {
    display: [32, 1.15, 700],
    title: [26, 1.2, 700],
    headline: [20, 1.3, 600],
    body: [17, 1.5, 400],
    callout: [16, 1.5, 400],
    caption: [13, 1.4, 400],
  },
} as const;

export const font = {
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif',
  mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
} as const;

export const shadow = {
  light: {
    1: "0 1px 2px rgba(26,26,24,.06), 0 1px 8px rgba(26,26,24,.04)",
    2: "0 8px 28px rgba(26,26,24,.12)",
  },
  dark: {
    1: "0 1px 2px rgba(0,0,0,.4), 0 1px 8px rgba(0,0,0,.3)",
    2: "0 8px 28px rgba(0,0,0,.5)",
  },
} as const;

export const layout = {
  contentMax: 1020,
  chatColumn: 760,
  stackBelow: 720,
  phoneMax: 430,
  tabletMax: 1024,
  touchTargetWeb: 44,
  touchTargetIos: 44,
  touchTargetAndroid: 48,
} as const;

export const motion = { fast: 120, base: 200, sheet: 280 } as const;

/**
 * Foreground/background pairs the UI actually uses, with the WCAG minimum each must meet.
 * 4.5 = normal text (AA). 3 = large text, icons, borders of controls and placeholder hints.
 * The contrast test fails CI if any pair drops below its minimum in either mode.
 */
export const contrastPairs: ReadonlyArray<[fg: ColorName, bg: ColorName, min: number]> = [
  ["ink", "bg", 4.5],
  ["ink", "surface", 4.5],
  ["ink", "surface2", 4.5],
  ["ink2", "bg", 4.5],
  ["ink2", "surface", 4.5],
  ["ink2", "surface2", 4.5],
  ["ink3", "surface", 3],
  ["accent", "bg", 4.5],
  ["accent", "surface", 4.5],
  ["accentInk", "accent", 4.5],
  ["accent", "accentSoft", 4.5],
  ["success", "surface", 4.5],
  ["success", "successSoft", 4.5],
  ["warn", "surface", 4.5],
  ["warn", "warnSoft", 4.5],
  ["danger", "surface", 4.5],
  ["danger", "dangerSoft", 4.5],
];

function channel(hex: string, i: number): number {
  const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  return 0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 1) + 0.0722 * channel(hex, 2);
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const kebab = (s: string) => s.replace(/([a-z])([A-Z0-9])/g, "$1-$2").toLowerCase();

/** CSS custom properties for one mode, e.g. `--accent: #0066CC;` */
export function cssVariables(mode: Mode): string {
  const lines = Object.entries(colors[mode]).map(([k, v]) => `  --${kebab(k)}: ${v};`);
  lines.push(`  --shadow-1: ${shadow[mode][1]};`, `  --shadow-2: ${shadow[mode][2]};`);
  return lines.join("\n");
}

export function cssStatic(): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(radius.web)) lines.push(`  --radius-${k}: ${v}px;`);
  for (const [k, v] of Object.entries(space)) lines.push(`  --space-${k}: ${v}px;`);
  for (const [k, [size, lh, weight]] of Object.entries(type.web)) {
    lines.push(
      `  --type-${k}-size: ${size}px;`,
      `  --type-${k}-lh: ${lh};`,
      `  --type-${k}-weight: ${weight};`,
    );
  }
  lines.push(`  --font: ${font.sans};`, `  --mono: ${font.mono};`);
  lines.push(
    `  --content-max: ${layout.contentMax}px;`,
    `  --chat-column: ${layout.chatColumn}px;`,
  );
  lines.push(`  --touch: ${layout.touchTargetWeb}px;`);
  lines.push(`  --motion-fast: ${motion.fast}ms;`, `  --motion-base: ${motion.base}ms;`);
  return lines.join("\n");
}

/**
 * Full stylesheet. Dark mode follows the system setting unless the page sets
 * data-theme="light" or data-theme="dark" on <html>.
 */
export function buildCss(): string {
  return `/* Generated by @ai-assistant/tokens. Do not edit by hand. */
:root {
${cssStatic()}
${cssVariables("light")}
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
${cssVariables("dark")}
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
${cssVariables("dark")}
  color-scheme: dark;
}
`;
}
