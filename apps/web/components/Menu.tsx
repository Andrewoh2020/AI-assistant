"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * A button that opens a small dropdown. The dropdown closes when you click or tap anywhere
 * outside it, press Escape, or choose an item.
 */
export function Menu({
  label,
  trigger,
  className,
  buttonClassName = "icon-btn",
  children,
}: {
  label: string;
  trigger: ReactNode;
  className?: string;
  buttonClassName?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    // Caught before anything else on the page, so Escape closes just the menu, not the sheet
    // (Settings) it sits in.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <div className={`more ${className ?? ""}`} ref={root}>
      <button
        className={buttonClassName}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {trigger}
      </button>
      {open && (
        <div className="menu" role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  icon,
  checked,
  danger,
  onSelect,
  children,
}: {
  icon?: ReactNode;
  checked?: boolean;
  danger?: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <button
      className={`menu-item ${danger ? "is-danger" : ""}`}
      type="button"
      role={checked === undefined ? "menuitem" : "menuitemcheckbox"}
      aria-checked={checked}
      onClick={onSelect}
    >
      <span className="menu-icon" aria-hidden="true">
        {checked === undefined ? icon : checked ? <CheckIcon /> : null}
      </span>
      {children}
    </button>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none">
      <path
        d="M5 12.5 10 17.5 19 7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
