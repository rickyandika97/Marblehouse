"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface Candidate {
  id: string;
  name: string;
  phoneDisplay: string;
  marbleBalance: number;
  ticketBalance: number;
}

export function MergeCustomer({ winnerId, winnerName }: { winnerId: string; winnerName: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Candidate[]>([]);
  const [loser, setLoser] = useState<Candidate | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const key = useRef(crypto.randomUUID());

  useEffect(() => {
    if (!open || query.trim().length < 3) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      const response = await fetch(`/api/customers?q=${encodeURIComponent(query)}`, {
        signal: controller.signal,
      }).catch(() => null);
      if (!response?.ok) return;
      const body = await response.json();
      setResults(body.customers.filter((candidate: Candidate) => candidate.id !== winnerId));
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, query, winnerId]);

  async function merge() {
    if (!loser) return;
    setSubmitting(true);
    try {
      const response = await fetch("/api/customers/merge", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": key.current,
        },
        body: JSON.stringify({ winnerId, loserId: loser.id }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        toast.error(body?.error?.message ?? "Could not merge those customers.");
        return;
      }
      toast.success(`${loser.name} was merged into ${winnerName}`);
      key.current = crypto.randomUUID();
      setOpen(false);
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>Merge duplicate</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Merge a duplicate into {winnerName}</DialogTitle>
            <DialogDescription>
              Sales and balance history move here. The duplicate is deactivated and remains in the audit trail.
            </DialogDescription>
          </DialogHeader>
          {!loser ? (
            <>
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search duplicate by phone or name"
              />
              <div className="max-h-64 space-y-2 overflow-y-auto">
                {results.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    className="flex min-h-14 w-full items-center rounded-lg border p-3 text-left hover:bg-muted"
                    onClick={() => setLoser(candidate)}
                  >
                    <span>
                      <span className="block font-semibold">{candidate.name}</span>
                      <span className="block text-sm text-muted-foreground">{candidate.phoneDisplay}</span>
                    </span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {candidate.marbleBalance} marbles · {candidate.ticketBalance} tickets
                    </span>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4">
              <p className="font-semibold">Merge {loser.name} into {winnerName}?</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Keep {winnerName}&apos;s name and phone. Move {loser.marbleBalance} marbles, {loser.ticketBalance} tickets, and all history.
              </p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => loser ? setLoser(null) : setOpen(false)}>
              {loser ? "Back" : "Cancel"}
            </Button>
            {loser && (
              <Button variant="destructive" disabled={submitting} onClick={merge}>
                {submitting && <Loader2 className="size-4 animate-spin" />}
                Merge permanently
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

