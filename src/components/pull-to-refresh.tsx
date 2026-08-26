"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Pull-to-refresh for the installed PWA.
 *
 * Every page in `(app)` is a server component fetched with
 * `dynamic = "force-dynamic"`, but navigation between tabs is client-side —
 * Next's router cache can and does serve a stale RSC payload for a route
 * you've already visited this session. In the browser that's invisible
 * because a manual reload is one tap away; in the standalone PWA there is no
 * chrome to reload from, so the only way to see fresh data was force-quitting
 * the app. `router.refresh()` busts the router cache for the current route
 * and re-runs its server component, which is exactly the fix — this
 * component just gives it the gesture users already expect from native apps.
 *
 * Deliberately scoped to wrap `<main>`'s children only (see app-shell.tsx),
 * not `window`: Radix dialogs portal to `document.body`, outside this
 * subtree, so a drag that starts inside an open dialog never reaches these
 * listeners and can't be mistaken for a pull.
 */

const TRIGGER_DISTANCE = 64; // px of pull before a release fires a refresh
const MAX_PULL = 96; // visual cap so the indicator can't be dragged forever
const DRAG_RESISTANCE = 0.5; // finger travel -> indicator travel

export function PullToRefresh({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [pull, setPull] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const startY = useRef<number | null>(null);
  const dragging = useRef(false);

  const reset = useCallback(() => {
    dragging.current = false;
    startY.current = null;
    setPull(0);
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    function atTop() {
      return (document.scrollingElement?.scrollTop ?? window.scrollY) <= 0;
    }

    function onTouchStart(e: TouchEvent) {
      const touch = e.touches[0];
      if (isPending || !touch || !atTop()) {
        startY.current = null;
        return;
      }
      startY.current = touch.clientY;
      dragging.current = true;
    }

    // Not passive: a genuine downward pull at the top of the page must
    // suppress the browser's own overscroll/bounce so our indicator tracks
    // the finger instead of fighting it.
    function onTouchMove(e: TouchEvent) {
      const touch = e.touches[0];
      if (!dragging.current || startY.current === null || !touch) return;
      const delta = touch.clientY - startY.current;
      if (delta <= 0 || !atTop()) {
        dragging.current = false;
        setPull(0);
        return;
      }
      e.preventDefault();
      setPull(Math.min(delta * DRAG_RESISTANCE, MAX_PULL));
    }

    function onTouchEnd() {
      if (dragging.current) {
        setPull((current) => {
          if (current >= TRIGGER_DISTANCE) {
            startTransition(() => {
              router.refresh();
            });
          }
          return current;
        });
      }
      dragging.current = false;
      startY.current = null;
      setPull(0);
    }

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("touchcancel", onTouchEnd);
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [isPending, router]);

  // Once a refresh actually starts, collapse any leftover drag state so the
  // indicator shows the spinner alone rather than a stale pull offset.
  useEffect(() => {
    if (isPending) reset();
  }, [isPending, reset]);

  const showIndicator = isPending || pull > 0;
  const indicatorHeight = isPending ? 40 : pull;
  const spinProgress = Math.min(pull / TRIGGER_DISTANCE, 1);

  return (
    <div ref={containerRef}>
      <div
        className="flex items-center justify-center overflow-hidden transition-[height] duration-150 ease-out"
        style={{ height: showIndicator ? indicatorHeight : 0 }}
        aria-hidden={!showIndicator}
      >
        <RefreshCw
          className={cn(
            "size-5 text-muted-foreground",
            isPending && "animate-spin"
          )}
          style={
            isPending
              ? undefined
              : { transform: `rotate(${spinProgress * 360}deg)` }
          }
        />
      </div>
      {children}
    </div>
  );
}
