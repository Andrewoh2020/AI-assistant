import Link from "next/link";

export default function Home() {
  return (
    <main style={{ maxWidth: "var(--chat-column)", margin: "0 auto", padding: "48px 20px" }}>
      <h1 style={{ fontSize: "var(--type-h1-size)", lineHeight: "var(--type-h1-lh)" }}>
        AI Assistant
      </h1>
      <p style={{ color: "var(--ink-2)" }}>
        The foundations are in place. Chat and research come in the next steps.
      </p>
      <p>
        <Link className="btn btn-primary" href="/design">
          See the design tokens
        </Link>
      </p>
    </main>
  );
}
