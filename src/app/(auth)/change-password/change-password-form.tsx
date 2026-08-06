"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function ChangePasswordForm({ forced }: { forced: boolean }) {
  const router = useRouter();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;

    if (newPassword !== confirm) {
      setError("The two new passwords do not match.");
      return;
    }

    setPending(true);
    setError(null);

    try {
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          forced ? { newPassword } : { currentPassword, newPassword }
        ),
      });

      const body = await res.json();

      if (!res.ok) {
        setError(body?.error?.message ?? "Could not change your password.");
        setPending(false);
        return;
      }

      // Changing the password destroys every session, including this one —
      // send them back to sign in with the new credentials.
      window.location.href = "/login";
    } catch {
      setError("Cannot reach the server. Check the shop's internet connection.");
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      {!forced && (
        <div className="space-y-2">
          <Label htmlFor="currentPassword">Current password</Label>
          <Input
            id="currentPassword"
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            autoComplete="current-password"
            required
            disabled={pending}
          />
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="newPassword">New password</Label>
        <Input
          id="newPassword"
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          autoComplete="new-password"
          required
          disabled={pending}
        />
        <p className="text-xs text-muted-foreground">
          At least 8 characters. Avoid anything easy to guess.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="confirm">Repeat new password</Label>
        <Input
          id="confirm"
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          required
          disabled={pending}
        />
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
        {pending ? "Saving…" : "Save new password"}
      </Button>

      {!forced && (
        <Button
          type="button"
          variant="ghost"
          size="lg"
          className="w-full"
          onClick={() => router.back()}
          disabled={pending}
        >
          Cancel
        </Button>
      )}
    </form>
  );
}
