/**
 * Reads the text out of files people attach, so the assistant can answer from them directly.
 * (Before this, the only way to read an attachment was to open it in the browser: slow and paid.)
 * Runs once, at upload. Files we can't read as text (images, archives) simply have no text.
 */

/** Most text we keep per file; about 100 dense pages. */
export const MAX_TEXT_CHARS = 400_000;

export interface Extracted {
  text: string | null;
  /** Page count, for PDFs. */
  pages?: number;
}

const TEXT_TYPES = /^(text\/|application\/(json|xml|csv|x-yaml|yaml|javascript|x-ndjson)\b)/;
const TEXT_EXTENSIONS = /\.(txt|md|markdown|csv|tsv|json|ndjson|xml|ya?ml|html?|log|ics|vcf|srt)$/i;
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export async function extractText(
  name: string,
  mime: string,
  data: Uint8Array,
): Promise<Extracted> {
  try {
    if (mime === "application/pdf" || /\.pdf$/i.test(name)) {
      const { extractText: pdfText, getDocumentProxy } = await import("unpdf");
      // pdf.js takes ownership of the buffer it's given, so it gets a copy.
      const pdf = await getDocumentProxy(new Uint8Array(data));
      const { totalPages, text } = await pdfText(pdf, { mergePages: false });
      const pages = text.map((t, i) => `[Page ${i + 1}]\n${t.trim()}`).join("\n\n");
      return { text: clean(pages), pages: totalPages };
    }
    if (mime === DOCX || /\.docx$/i.test(name)) {
      const mammoth = await import("mammoth");
      const { value } = await mammoth.extractRawText({ buffer: Buffer.from(data) });
      return { text: clean(value) };
    }
    if (TEXT_TYPES.test(mime) || TEXT_EXTENSIONS.test(name)) {
      const raw = new TextDecoder("utf-8", { fatal: false }).decode(data);
      return { text: clean(/html?$/i.test(mime) || /\.html?$/i.test(name) ? stripHtml(raw) : raw) };
    }
  } catch {
    // A damaged or locked file: treat it as unreadable rather than failing the upload.
  }
  return { text: null };
}

function clean(text: string): string | null {
  const tidy = text
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  // A PDF that's only page markers (a scan) has no real text.
  if (!tidy.replace(/\[Page \d+\]/g, "").trim()) return null;
  return tidy.length > MAX_TEXT_CHARS ? tidy.slice(0, MAX_TEXT_CHARS) : tidy;
}

function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
