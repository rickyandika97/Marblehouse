import type { MarbleTxnType, TicketTxnType } from "@prisma/client";

export type LedgerKind = "MARBLE" | "TICKET";

export interface LedgerEntryDTO {
  id: string;
  kind: LedgerKind;
  type: MarbleTxnType | TicketTxnType;
  delta: number;
  balanceAfter: number;
  reason: string | null;
  businessDate: string;
  occurredAt: string;
  shop: { id: string; name: string };
  recordedBy: { id: string; displayName: string };
}

export interface BalanceMutationDTO {
  entry: LedgerEntryDTO;
  customer: {
    id: string;
    marbleBalance: number;
    ticketBalance: number;
  };
}

