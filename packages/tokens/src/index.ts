/**
 * Design tokens for web and mobile. Colors, type sizes and corner radii are measured from the
 * Muse iPhone app (screenshots Andrew shared on 2026-10-20): near-white page, gray assistant
 * bubbles, light-blue user bubbles, near-black text, blue links, Apple's system font.
 * Dark mode is derived from the same scheme until we have Muse dark-mode screenshots.
 * One source: `scripts/build-css.mjs` turns this into CSS variables for the web app,
 * and the mobile app will import the same objects as a typed theme.
 */

export type Mode = "light" | "dark";

export const colors = {
  light: {
    /** Page and sidebar background. */
    bg: "#FCFCFC",
    /** Floating controls: message box, round buttons, cards. Shown with a soft shadow. */
    surface: "#FFFFFF",
    /** Code blocks and quiet fills. */
    surface2: "#F3F4F5",
    /** The current item in the sidebar and tab bar. */
    selected: "#EEEFF0",
    /** Assistant message bubble. */
    bubble: "#E9EAEB",
    /** Divider inside an assistant bubble (above Sources). */
    bubbleLine: "#D5D6D8",
    /** User message bubble. */
    bubbleUser: "#BFDAFB",
    ink: "#111111",
    ink2: "#666769",
    /** Muse's hint gray: placeholders and small section labels only. */
    ink3: "#A4A6A9",
    line: "#E2E2E2",
    /** Links and citations. */
    accent: "#2962CD",
    accentInk: "#FFFFFF",
    accentSoft: "#DCE7FA",
    success: "#18794E",
    successSoft: "#E6F4EC",
    warn: "#8A5F00",
    warnSoft: "#FDF3D7",
    danger: "#C92A2A",
    dangerSoft: "#FDECEC",
  },
  dark: {
    bg: "#0F0F10",
    surface: "#1C1C1E",
    surface2: "#232325",
    selected: "#2A2A2C",
    bubble: "#262729",
    bubbleLine: "#3A3B3E",
    bubbleUser: "#1F3B5E",
    ink: "#F2F2F3",
    ink2: "#A3A5A8",
    ink3: "#6F7174",
    line: "#2C2D2F",
    accent: "#7FABF2",
    accentInk: "#0B1A2B",
    accentSoft: "#1E2D47",
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
  web: { s: 10, m: 16, l: 20, pill: 999 },
  mobile: { s: 10, m: 16, l: 20, pill: 999 },
} as const;

export const space = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 24, 6: 32, 8: 48 } as const;

/** [size px, line-height, weight] */
export const type = {
  web: {
    display: [34, 1.15, 700],
    h1: [24, 1.2, 700],
    h2: [21, 1.25, 700],
    h3: [17, 1.3, 600],
    body: [17, 1.3, 400],
    small: [15, 1.35, 400],
    caption: [13, 1.3, 500],
  },
  mobile: {
    display: [34, 1.15, 700],
    title: [24, 1.2, 700],
    headline: [20, 1.25, 600],
    body: [17, 1.3, 400],
    callout: [15, 1.35, 400],
    caption: [13, 1.3, 500],
  },
} as const;

export const font = {
  // Muse uses Apple's system font (SF Pro); other systems get their closest equivalent.
  sans: 'system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
} as const;

export const shadow = {
  light: {
    1: "0 1px 3px rgba(0,0,0,.06), 0 4px 16px rgba(0,0,0,.06)",
    2: "0 8px 32px rgba(0,0,0,.12)",
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
  ["ink", "selected", 4.5],
  ["ink", "bubble", 4.5],
  ["ink", "bubbleUser", 4.5],
  ["ink2", "bubble", 4.5],
  ["ink2", "bg", 4.5],
  ["ink2", "surface", 4.5],
  ["ink2", "surface2", 4.5],
  // ink3 is Muse's own hint gray (about 2.4:1). Kept to match Muse; it is used only for
  // placeholders and section labels, never for content.
  ["ink3", "surface", 2.3],
  ["accent", "bg", 4.5],
  ["accent", "surface", 4.5],
  ["accent", "bubble", 4.5],
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
