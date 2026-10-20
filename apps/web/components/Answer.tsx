"use client";

import type { MessageView, SourceView } from "@ai-assistant/api-client";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { FileList } from "./Files";

/** Turns [n] markers into links the renderer draws as citation chips. Unknown numbers stay out. */
function linkCitations(text: string, sources: SourceView[]): string {
  const known = new Set(sources.map((s) => s.n));
  return text.replace(/\[(\d{1,3})\](?!\()/g, (whole, n: string) =>
    known.has(Number(n)) ? `[${n}](#cite-${n})` : "",
  );
}

export function Answer({
  message,
  onCite,
  highlight = null,
}: {
  message: MessageView;
  onCite: (message: MessageView, n: number) => void;
  highlight?: number | null;
}) {
  const components: Components = {
    a({ href, children }) {
      if (href?.startsWith("#cite-")) {
        const n = Number(href.slice(6));
        const source = message.sources.find((s) => s.n === n);
        return (
          <button
            type="button"
            className="cite"
            aria-label={`Source ${n}: ${source?.title ?? source?.url ?? ""}`}
            onClick={() => onCite(message, n)}
          >
            {n}
          </button>
        );
      }
      return (
        <a href={href} target="_blank" rel="noopener noreferrer nofollow">
          {children}
        </a>
      );
    },
  };

  return (
    <div className="answer">
      <div className="markdown">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {linkCitations(message.text, message.sources)}
        </ReactMarkdown>
      </div>

      <FileList files={message.files} />

      {message.sources.length > 0 && <SourcesList message={message} highlight={highlight} />}

      {message.reasoning && (
        <details className="reasoning">
          <summary>How I worked this out</summary>
          {/* Plain text on purpose: no clickable links from the model's private notes. */}
          <p>{message.reasoning}</p>
        </details>
      )}
    </div>
  );
}

export function SourcesList({
  message,
  highlight,
}: {
  message: MessageView;
  highlight?: number | null;
}) {
  return (
    <section className="sources" aria-label="Sources">
      <h3>Sources</h3>
      <ol>
        {message.sources.map((s) => (
          <li
            key={s.n}
            id={`src-${message.id}-${s.n}`}
            className={highlight === s.n ? "is-highlighted" : undefined}
            value={s.n}
          >
            <a href={s.url} target="_blank" rel="noopener noreferrer nofollow">
              {s.title || s.url}
            </a>
            <span className="source-meta">
              {[s.siteName ?? hostname(s.url), s.date].filter(Boolean).join(" · ")}
            </span>
            {s.flagged && (
              <span className="badge badge-warn">
                This page contained instructions aimed at the assistant; they were ignored
              </span>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
