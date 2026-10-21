import { postJson } from "./http.js";

export interface SearchResult {
  title: string;
  url: string;
  siteName?: string;
  date?: string;
  summary: string;
  authority?: number;
}

export interface FetchedPage {
  title: string;
  text: string;
}

/**
 * The search engine behind web_search and fetch_page. DeepSeek today; Brave (or Travila, if it
 * adds search) can replace it by implementing this interface.
 */
export interface SearchBackend {
  search(query: string, count: number): Promise<SearchResult[]>;
  fetch(url: string): Promise<FetchedPage>;
}

interface DeepSeekResult {
  title?: string;
  url?: string;
  site_name?: string;
  date?: string;
  summary?: string;
  snippet?: string;
  authority?: string | number;
}

/** DeepSeek's Fetch returns Markdown with punctuation escaped (\#, \.); undo that. */
export function unescapeMarkdown(s: string): string {
  return s.replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, "$1");
}

/** Some results repeat their title ("A - A"); keep one copy. */
export function cleanTitle(title: string): string {
  const parts = title.split(" - ");
  if (parts.length === 2 && parts[0]!.trim() === parts[1]!.trim()) return parts[0]!.trim();
  return title.trim();
}

export class DeepSeekSearch implements SearchBackend {
  constructor(
    private readonly base: string,
    private readonly apiKey: string,
  ) {}

  private headers(): Record<string, string> {
    return this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {};
  }

  async search(query: string, count: number): Promise<SearchResult[]> {
    const res = await postJson<{ results?: DeepSeekResult[] }>(
      "DeepSeek Search",
      `${this.base}/v1/tools/search`,
      { query: query.slice(0, 128), count },
      this.headers(),
      { timeoutMs: 20000 },
    );
    return (res.results ?? [])
      .filter((r) => r.url)
      .map((r) => ({
        title: cleanTitle(r.title ?? r.url!),
        url: r.url!.replace(/#\d+$/, ""), // DeepSeek appends "#1"-style markers to some URLs

        siteName: r.site_name,
        date: r.date,
        summary: (r.summary || r.snippet || "").slice(0, 1200),
        authority: r.authority === undefined ? undefined : Number(r.authority),
      }));
  }

  async fetch(url: string): Promise<FetchedPage> {
    const res = await postJson<{ title?: string; content?: string }>(
      "DeepSeek Fetch",
      `${this.base}/v1/tools/fetch`,
      { url },
      this.headers(),
      { timeoutMs: 30000 },
    );
    return { title: res.title ?? url, text: unescapeMarkdown(res.content ?? "") };
  }
}
