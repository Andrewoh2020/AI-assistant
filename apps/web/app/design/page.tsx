import type { CSSProperties } from "react";
import {
  brand,
  colors,
  contrastPairs,
  contrastRatio,
  type ColorName,
  type Mode,
  shadow,
  type as typeScale,
} from "@ai-assistant/tokens";

export const metadata = { title: "Design tokens · Ability" };

const kebab = (s: string) => s.replace(/([a-z])([A-Z0-9])/g, "$1-$2").toLowerCase();

/** Sets the token variables for one mode on a panel, so light and dark sit side by side. */
function modeVars(mode: Mode): CSSProperties {
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(colors[mode])) vars[`--${kebab(k)}`] = v;
  vars["--shadow-1"] = shadow[mode][1];
  vars["--shadow-2"] = shadow[mode][2];
  return vars as CSSProperties;
}

function Panel({ mode }: { mode: Mode }) {
  const c = colors[mode];
  return (
    <section
      aria-label={`${mode} mode`}
      style={{
        ...modeVars(mode),
        background: "var(--bg)",
        color: "var(--ink)",
        borderRadius: "var(--radius-l)",
        border: "1px solid var(--line)",
        padding: 24,
        flex: "1 1 420px",
        minWidth: 0,
      }}
    >
      <h2 style={{ marginTop: 0, fontSize: "var(--type-h2-size)" }}>
        {mode === "light" ? "Light" : "Dark"} mode
      </h2>

      <h3>Colors</h3>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))",
          gap: 10,
        }}
      >
        {(Object.keys(c) as ColorName[]).map((name) => (
          <div key={name} style={{ fontSize: 13 }}>
            <div
              style={{
                height: 44,
                borderRadius: "var(--radius-m)",
                border: "1px solid var(--line)",
                background: c[name],
              }}
            />
            <div style={{ fontWeight: 600 }}>{name}</div>
            <code>{c[name]}</code>
          </div>
        ))}
      </div>

      <h3>Buttons</h3>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className="btn btn-primary" type="button">
          Approve
        </button>
        <button className="btn btn-secondary" type="button">
          Review first
        </button>
        <button className="btn btn-ghost" type="button">
          Cancel
        </button>
        <button className="btn btn-primary" type="button" disabled>
          Working…
        </button>
      </div>

      <h3>Card</h3>
      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--line)",
          borderRadius: "var(--radius-m)",
          boxShadow: "var(--shadow-1)",
          padding: 16,
        }}
      >
        <div style={{ fontWeight: 600 }}>Answer card</div>
        <p style={{ margin: "4px 0 0", color: "var(--ink-2)", fontSize: 14 }}>
          Secondary text sits on the surface colour. Links look <a href="#top">like this</a>.
        </p>
      </div>

      <h3>Contrast checks (WCAG AA)</h3>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left" }}>Text on background</th>
            <th style={{ textAlign: "right" }}>Ratio</th>
            <th style={{ textAlign: "right" }}>Needs</th>
            <th style={{ textAlign: "right" }}>Result</th>
          </tr>
        </thead>
        <tbody>
          {contrastPairs.map(([fg, bg, min]) => {
            const ratio = contrastRatio(c[fg], c[bg]);
            const pass = ratio >= min;
            return (
              <tr key={`${fg}-${bg}`} style={{ borderTop: "1px solid var(--line)" }}>
                <td>
                  <span
                    style={{ background: c[bg], color: c[fg], padding: "2px 8px", borderRadius: 6 }}
                  >
                    {fg} on {bg}
                  </span>
                </td>
                <td style={{ textAlign: "right" }}>{ratio.toFixed(2)}:1</td>
                <td style={{ textAlign: "right" }}>{min}:1</td>
                <td
                  style={{ textAlign: "right", color: pass ? "var(--success)" : "var(--danger)" }}
                >
                  {pass ? "Pass" : "Fail"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

export default function DesignPage() {
  return (
    <main id="top" style={{ maxWidth: 1200, margin: "0 auto", padding: "32px 20px 72px" }}>
      <h1 style={{ fontSize: "var(--type-h1-size)", marginBottom: 4 }}>Design tokens</h1>
      <p style={{ color: "var(--ink-2)", marginTop: 0 }}>
        From Muse&apos;s web and mobile design system, with the blue accent from the architecture
        plan. Every value here comes from <code>packages/tokens</code>; CI fails if any pair below
        drops under its contrast minimum.
      </p>

      <h2 style={{ fontSize: "var(--type-h2-size)" }}>Brand: {brand.name}</h2>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 32,
          marginBottom: 16,
        }}
      >
        {/* eslint-disable @next/next/no-img-element */}
        <img src="/brand/ability-icon.png" alt="Ability app icon" width={64} height={64} />
        <img src="/brand/ability-wordmark.png" alt="Ability wordmark" width={184} height={48} />
        <img
          src="/brand/ability-wordmark-stacked.png"
          alt="Ability stacked wordmark"
          width={86}
          height={104}
        />
        {/* eslint-enable @next/next/no-img-element */}
        <div
          aria-label="Brand gradient"
          style={{
            width: 160,
            height: 48,
            borderRadius: "var(--radius-m)",
            background: `linear-gradient(${brand.gradient.angle}deg, ${brand.gradient.start}, ${brand.gradient.middle}, ${brand.gradient.end})`,
          }}
        />
      </div>
      <p style={{ color: "var(--ink-2)", marginTop: 0, marginBottom: 24 }}>
        Originals of all logo variations are in <code>packages/tokens/brand</code>.
      </p>

      <h2 style={{ fontSize: "var(--type-h2-size)" }}>Type scale (web)</h2>
      <div style={{ marginBottom: 24 }}>
        {Object.entries(typeScale.web).map(([name, [size, lh, weight]]) => (
          <div key={name} style={{ fontSize: size, lineHeight: lh, fontWeight: weight }}>
            {name} · {size}px
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
        <Panel mode="light" />
      </div>
    </main>
  );
}
