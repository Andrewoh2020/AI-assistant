import { createHash } from "node:crypto";
import { withUser, type FileRow, type Sql } from "@ai-assistant/db";
import type { FileView } from "@ai-assistant/api-client";

/**
 * Files people attach and files the browser downloads. We keep our own copy of every file in the
 * database (storage 'own'), so the original stays downloadable whatever happens elsewhere.
 */

/** Largest file we accept or copy out of the browser. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export function fileView(f: FileRow): FileView {
  return {
    id: f.id,
    name: f.name ?? "file",
    mime: f.mime ?? "application/octet-stream",
    bytes: Number(f.bytes ?? 0),
    kind: f.kind === "browser_download" ? "download" : "upload",
  };
}

/** Keeps only characters that are safe in a file name, and a sensible length. */
export function cleanFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 180);
  return cleaned || "file";
}

export async function saveFile(
  sql: Sql,
  userId: string,
  input: {
    kind: "upload" | "browser_download";
    name: string;
    mime: string;
    data: Uint8Array;
    chatId?: string | null;
    runId?: string | null;
  },
): Promise<FileRow> {
  const sha256 = createHash("sha256").update(input.data).digest("hex");
  return withUser(sql, userId, async (tx) => {
    const [file] = await tx<FileRow[]>`
      INSERT INTO files (user_id, kind, storage, storage_key, name, mime, bytes, sha256, chat_id, run_id)
      VALUES (${userId}, ${input.kind}, 'own', ${sha256}, ${cleanFileName(input.name)},
              ${input.mime.slice(0, 120) || "application/octet-stream"}, ${input.data.byteLength},
              ${sha256}, ${input.chatId ?? null}, ${input.runId ?? null})
      RETURNING *`;
    await tx`INSERT INTO file_blobs (file_id, user_id, data)
             VALUES (${file!.id}, ${userId}, ${Buffer.from(input.data)})`;
    return file!;
  });
}

/** The file and its bytes, or null when it isn't this user's (row-level security). */
export async function readFile(
  sql: Sql,
  userId: string,
  fileId: string,
): Promise<{ file: FileRow; data: Buffer } | null> {
  return withUser(sql, userId, async (tx) => {
    const [file] = await tx<FileRow[]>`SELECT * FROM files WHERE id = ${fileId}`;
    if (!file) return null;
    const [blob] = await tx<
      { data: Buffer }[]
    >`SELECT data FROM file_blobs WHERE file_id = ${fileId}`;
    return blob ? { file, data: blob.data } : null;
  });
}

/** The line added to the user's message so the model knows which files came with it. */
export function attachmentNote(files: FileRow[]): string {
  if (!files.length) return "";
  const lines = files.map((f) => {
    const kb = Math.max(1, Math.round(Number(f.bytes ?? 0) / 1024));
    return `- "${f.name}" (file_id: ${f.id}, ${f.mime}, ${kb} KB)`;
  });
  return `\n\n[Attached files]\n${lines.join("\n")}`;
}

/** Guesses a type from the extension, for files the browser saved. */
export function mimeFor(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const types: Record<string, string> = {
    pdf: "application/pdf",
    txt: "text/plain",
    md: "text/markdown",
    csv: "text/csv",
    json: "application/json",
    html: "text/html",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    zip: "application/zip",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  };
  return types[ext] ?? "application/octet-stream";
}
