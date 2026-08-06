"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export function TicketAwardThresholdForm({ initial }: { initial: number }) {
  const [value, setValue] = useState(String(initial));
  const [saving, setSaving] = useState(false);
  const key = useRef(crypto.randomUUID());
  const parsed = Number(value);

  async function save() {
    if (!Number.isInteger(parsed) || parsed < 1) return;
    setSaving(true);
    try {
      const response = await fetch("/api/settings/ticket-award-threshold", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": key.current,
        },
        body: JSON.stringify({ threshold: parsed }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        toast.error(body?.error?.message ?? "Could not save that threshold.");
        return;
      }
      key.current = crypto.randomUUID();
      toast.success(`Awards above ${body.threshold.toLocaleString("id-ID")} tickets now require a reason.`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Ticket-award reason threshold</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Staff must explain any single award above this number. The award is not blocked when a reason is supplied.
        </p>
        <div className="flex max-w-md gap-3">
          <Input
            inputMode="numeric"
            value={value}
            onChange={(event) => setValue(event.target.value.replace(/\D/g, ""))}
          />
          <Button disabled={saving || !Number.isInteger(parsed) || parsed < 1} onClick={save}>
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

