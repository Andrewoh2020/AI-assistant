"use client";

import { useEffect, useState } from "react";

/**
 * A small per-browser setting (like "Keep chat panel visible"), remembered between visits.
 * Falls back to the default when the browser blocks storage.
 */
export function usePref(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(`aia:${key}`);
      if (saved !== null) setValue(saved === "1");
    } catch {
      // Storage unavailable: keep the default.
    }
  }, [key]);
  const update = (v: boolean) => {
    setValue(v);
    try {
      localStorage.setItem(`aia:${key}`, v ? "1" : "0");
    } catch {
      // Storage unavailable: the setting lasts for this visit only.
    }
  };
  return [value, update];
}
