"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DEFAULT_CUSTOMER_WHATSAPP_REMINDER_TEMPLATE } from "@/lib/customer-whatsapp";

export function CustomerWhatsAppReminderForm({ initial }: { initial: string }) {
  const [template, setTemplate] = useState(initial);
  const [saving, setSaving] = useState(false);
  const key = useRef(crypto.randomUUID());

  async function save() {
    if (!template.trim() || saving) return;
    setSaving(true);
    try {
      const response = await fetch("/api/settings/customer-whatsapp-reminder", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": key.current,
        },
        body: JSON.stringify({ template: template.trim() }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        toast.error(body?.error?.message ?? "Could not save that reminder.");
        return;
      }
      key.current = crypto.randomUUID();
      setTemplate(body.template);
      toast.success("WhatsApp reminder saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Customer WhatsApp reminder</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          This fills a WhatsApp draft when staff tap a customer&apos;s shortcut.
          Use {"{name}"}, {"{marbles}"}, and {"{tickets}"} for that
          customer&apos;s current details. It never sends a message automatically.
        </p>
        <textarea
          value={template}
          maxLength={1_000}
          onChange={(event) => setTemplate(event.target.value)}
          className="min-h-32 w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          aria-label="Customer WhatsApp reminder message"
        />
        <div className="flex flex-wrap gap-2">
          <Button disabled={saving || !template.trim()} onClick={save}>
            {saving ? "Saving…" : "Save reminder"}
          </Button>
          <Button
            variant="outline"
            disabled={saving || template === DEFAULT_CUSTOMER_WHATSAPP_REMINDER_TEMPLATE}
            onClick={() => setTemplate(DEFAULT_CUSTOMER_WHATSAPP_REMINDER_TEMPLATE)}
          >
            Reset to default
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
