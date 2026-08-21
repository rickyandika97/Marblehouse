"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

/**
 * Keeps the visual switch compact while preserving the app's 44px minimum
 * touch target. next-themes persists the choice between visits.
 */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const isDark = resolvedTheme === "dark";

  return (
    <button
      type="button"
      role="switch"
      aria-checked={isDark}
      aria-label={`Use ${isDark ? "light" : "dark"} mode`}
      title={`Use ${isDark ? "light" : "dark"} mode`}
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className="group flex size-11 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="relative h-6 w-10 rounded-full border border-border bg-muted shadow-inner transition-colors group-hover:bg-accent dark:bg-primary">
        <span className="absolute left-0.5 top-0.5 flex size-[18px] items-center justify-center rounded-full bg-background text-muted-foreground shadow-sm transition-transform dark:translate-x-4 dark:text-foreground">
          {isDark ? (
            <Moon className="size-3" aria-hidden />
          ) : (
            <Sun className="size-3" aria-hidden />
          )}
        </span>
      </span>
    </button>
  );
}
