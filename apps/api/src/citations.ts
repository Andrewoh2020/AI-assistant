/**
 * Turns the model's finished answer into what the user sees:
 * - links or bare URLs that aren't among the run's sources are removed (identifier grounding),
 * - citation markers [n] that don't match a source number are dropped,
 * - the cited source numbers are returned for the Sources list.
 */
export interface GroundingResult {
  text: string;
  cited: number[];
  removedUrls: string[];
}

const MD_LINK = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
const BARE_URL = /(?<![("\w])https?:\/\/[^\s)<>\]]+/g;
const CITE = /\[(\d{1,3})\](?!\()/g;

const normalise = (u: string) => u.replace(/[.,;:!?]+$/, "").replace(/\/$/, "");

export function groundAnswer(text: string, sourceUrls: Map<number, string>): GroundingResult {
  const allowed = new Set([...sourceUrls.values()].map(normalise));
  const removedUrls: string[] = [];

  let out = text.replace(MD_LINK, (whole, label: string, url: string) => {
    if (allowed.has(normalise(url))) return whole;
    removedUrls.push(url);
    return label;
  });
  out = out.replace(BARE_URL, (match) => {
    const url = match.replace(/[.,;:!?]+$/, "");
    const trailing = match.slice(url.length);
    if (allowed.has(normalise(url))) return match;
    removedUrls.push(url);
    return trailing;
  });

  const cited: number[] = [];
  out = out.replace(CITE, (whole, n: string) => {
    const num = Number(n);
    if (!sourceUrls.has(num)) return "";
    if (!cited.includes(num)) cited.push(num);
    return whole;
  });

  return { text: out.replace(/[ \t]+\n/g, "\n").trim(), cited, removedUrls };
}
