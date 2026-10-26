"use client";
import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

export function ThemeToggle() {
  const [dark, setDark] = useState(false);
  // Read the theme applied by themeInitScript after mount (it is unknown during SSR).
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setDark(document.documentElement.classList.contains("dark")), []);
  return (
    <button
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      onClick={() => {
        const next = !dark;
        document.documentElement.classList.toggle("dark", next);
        try { localStorage.setItem("yp-theme", next ? "dark" : "light"); } catch {}
        setDark(next);
      }}
      className="rounded-lg p-2 text-ink-muted hover:bg-surface-muted hover:text-ink"
    >
      {dark ? <Sun className="size-5" /> : <Moon className="size-5" />}
    </button>
  );
}

/** Inline script content: applies the saved theme before first paint (no flash). */
export const themeInitScript = `try{var t=localStorage.getItem("yp-theme");if(t==="dark"||(!t&&matchMedia("(prefers-color-scheme: dark)").matches))document.documentElement.classList.add("dark")}catch(e){}`;
