"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function LoginForm() {
  const params = useSearchParams();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;

    setPending(true);
    setError(null);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      const body = await res.json();

      if (!res.ok) {
        setError(body?.error?.message ?? "Could not log you in.");
        setPending(false);
        return;
      }

      // Where to go next is decided by the server on the following request:
      // forced password change, then the day-start picker, then the role's
      // home screen. "/" resolves all three in order.
      const next = params.get("next");
      const target = next && next.startsWith("/") ? next : "/";

      // FULL page load, deliberately — not router.replace() + router.refresh().
      //
      // Those two ran back-to-back here: replace() starts a soft RSC
      // navigation and refresh() immediately invalidates the router cache
      // underneath it. When that raced, the navigation never resolved, and
      // because the success path never clears `pending` (there is normally
      // nothing left to clear — the page goes away), the button span forever.
      // Reported 25 Aug 2026 on iOS Safari: sign-in succeeded server-side
      // every time (a fresh `session` row per attempt) while the button span
      // indefinitely. Intermittent, and it varied by browser and by whether
      // site data had just been cleared — the signature of a timing race, not
      // of a network or auth fault.
      //
      // A hard navigation sidesteps the whole class of problem: the browser
      // re-requests the page with whatever session cookie it just stored, with
      // no RSC cache in the path. It also fails VISIBLY — if the cookie did
      // not stick, the user lands back on a rendered login page instead of
      // watching a spinner forever. Slightly slower, and worth it here.
      window.location.replace(target);
    } catch {
      setError("Cannot reach the server. Check the shop's internet connection.");
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="username">Username</Label>
        <Input
          id="username"
          name="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          disabled={pending}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <div className="relative">
          <Input
            id="password"
            name="password"
            type={showPassword ? "text" : "password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
            disabled={pending}
            className="pr-14"
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            aria-label={showPassword ? "Hide password" : "Show password"}
            className="absolute inset-y-0 right-0 flex w-14 items-center justify-center text-muted-foreground"
          >
            {showPassword ? (
              <EyeOff className="size-5" />
            ) : (
              <Eye className="size-5" />
            )}
          </button>
        </div>
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-lg bg-destructive/10 px-4 py-3 text-sm font-medium text-destructive"
        >
          {error}
        </p>
      )}

      <Button type="submit" size="xl" className="w-full" disabled={pending}>
        {pending && <Loader2 className="animate-spin" />}
        {pending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
