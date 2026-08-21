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
  /** Present for ticket entries tied to a prize redemption. */
  redeemedItems?: Array<{ name: string; qty: number; ticketCostTotal: number }>;
}

export interface BalanceMutationDTO {
  entry: LedgerEntryDTO;
  customer: {
    id: string;
    marbleBalance: number;
    ticketBalance: number;
  };
}
