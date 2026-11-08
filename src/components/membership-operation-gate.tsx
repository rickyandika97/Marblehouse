"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Gift } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MembershipCard } from "@/components/membership-card";
import { MembershipScanner } from "@/components/membership-scanner";

/** Every action rechecks current state, including verification expiry in an open tab. */
export function useMembershipOperationGate(customerId: string) {
  const [phase, setPhase] = useState<"activate" | "scan" | null>(null);
  const [checking, setChecking] = useState(false);
  const pending = useRef<(() => void) | null>(null);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  function cancel() {
    generation.current++;
    pending.current = null;
    setPhase(null);
    setChecking(false);
  }
  async function authorize(proceed: () => void) {
    const request = ++generation.current;
    setChecking(true);
    try {
      const response = await fetch(
        `/api/customers/${customerId}/membership/status`,
        { cache: "no-store" },
      );
      const status = await response.json();
      if (generation.current !== request) return;
      if (!response.ok) {
        toast.error(status?.error?.message ?? "Could not check membership.");
        return;
      }
      if (status.verified) {
        proceed();
        return;
      }
      pending.current = proceed;
      setPhase(status.activated ? "scan" : "activate");
    } catch {
      if (generation.current === request)
        toast.error("No connection. Check the wifi and try again.");
    } finally {
      if (generation.current === request) setChecking(false);
    }
  }
  function verified() {
    const proceed = pending.current;
    pending.current = null;
    setPhase(null);
    proceed?.();
  }
  const dialog =
    phase === "activate" ? (
      <MembershipCard
        customerId={customerId}
        autoOpen
        hideTrigger
        onDone={cancel}
        onActivated={() => setPhase("scan")}
      />
    ) : phase === "scan" ? (
      <MembershipScanner
        customerId={customerId}
        autoOpen
        hideTrigger
        onCancel={cancel}
        onVerified={verified}
      />
    ) : null;
  return { authorize, checking, dialog };
}

export function RedeemMembershipButton({ customerId }: { customerId: string }) {
  const router = useRouter();
  const gate = useMembershipOperationGate(customerId);
  return (
    <>
      <Button
        size="xl"
        className="w-full"
        disabled={gate.checking}
        onClick={() =>
          gate.authorize(() => router.push(`/customers/${customerId}/redeem`))
        }
      >
        <Gift className="size-5" />
        Redeem prizes
      </Button>
      {gate.dialog}
    </>
  );
}

/** Guards direct redemption links as well as the normal profile button. */
export function MembershipRequired({
  customerId,
  needsActivation,
}: {
  customerId: string;
  needsActivation: boolean;
}) {
  const router = useRouter();
  const [activate, setActivate] = useState(needsActivation);
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">
        {activate ? "Activate membership" : "Verify membership"}
      </h1>
      <p>
        {activate
          ? "Give the customer their first card, activate it, then scan their QR to continue."
          : "Scan the customer's membership QR to continue."}
      </p>
      {activate ? (
        <MembershipCard
          customerId={customerId}
          autoOpen
          onDone={() => router.replace(`/customers/${customerId}`)}
          onActivated={() => setActivate(false)}
        />
      ) : (
        <MembershipScanner
          customerId={customerId}
          autoOpen
          onVerified={() => router.refresh()}
        />
      )}
      <Button variant="ghost" onClick={() => router.replace("/customers")}>
        All customers
      </Button>
    </div>
  );
}
