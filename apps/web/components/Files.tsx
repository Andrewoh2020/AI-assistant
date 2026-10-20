"use client";

import type { FileView } from "@ai-assistant/api-client";
import { api } from "@/lib/client";

function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A file on a message. Clicking downloads the original. */
export function FileChip({ file, onRemove }: { file: FileView; onRemove?: () => void }) {
  return (
    <span className="file-chip">
      <a
        className="file-chip-link"
        href={api.fileUrl(file.id)}
        download={file.name}
        title={`Download ${file.name}`}
      >
        <FileIcon />
        <span className="file-chip-name">{file.name}</span>
        <span className="file-chip-size">{size(file.bytes)}</span>
      </a>
      {onRemove && (
        <button
          type="button"
          className="file-chip-remove"
          onClick={onRemove}
          aria-label={`Remove ${file.name}`}
        >
          ×
        </button>
      )}
    </span>
  );
}

export function FileList({ files }: { files: FileView[] }) {
  if (!files.length) return null;
  return (
    <div className="file-list">
      {files.map((f) => (
        <FileChip key={f.id} file={f} />
      ))}
    </div>
  );
}

export function FileIcon() {
  return (
    <svg className="file-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z M14 3v5h5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function PaperclipIcon() {
  return (
    <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M20.5 11.5l-8.2 8.2a5 5 0 0 1-7.1-7.1l8.6-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
