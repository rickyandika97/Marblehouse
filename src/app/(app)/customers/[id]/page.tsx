import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Gift, MessageCircle } from "lucide-react";
import { requireActorPage } from "@/server/auth/page-guard";
import { getCustomerForActor } from "@/server/services/customers";
import { listSales } from "@/server/services/sales";
import { listRedemptions } from "@/server/services/redemptions";
import { listCustomerLedger } from "@/server/services/balances";
import {
  getCustomerWhatsAppReminderTemplate,
  getTicketAwardReasonThreshold,
} from "@/server/services/settings";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/money";
import { AppError } from "@/server/errors";
import {
  customerWhatsAppUrl,
  renderCustomerWhatsAppReminder,
} from "@/lib/customer-whatsapp";
import type { CustomerOwnerDTO } from "@/server/dto/customer";
import { BalanceActions } from "./balance-actions";
import { EditCustomer } from "./edit-customer";
import { MergeCustomer } from "./merge-customer";

export const metadata = { title: "Customer · Marblehouse" };
export const dynamic = "force-dynamic";

/**
 * Customer detail (§8.5).
 *
 *   All roles: name, phone, marble balance, ticket balance.
 *   OWNER only: spend, visit history, active days, preferred shop.
 *
 * The owner-only block is driven by the DTO the service returned, not by a role
 * check in the markup — a manager's response physically has no `totalSpend` on
 * it to render (§7.5).
 *
 * Phase 3 supplied Deposit, Withdraw and Award; Phase 4 adds Redeem, which is
 * a link to /redeem rather than a dialog — a cart is too big for a modal, and
 * §8.6 wants a full screen with the balance pinned at the top.
 */
export default async function CustomerDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ledgerCursor?: string }>;
}) {
  const actor = await requireActorPage();
  const { id } = await params;
  const { ledgerCursor } = await searchParams;

  const customer = await getCustomerForActor(actor, id).catch((e) => {
    if (e instanceof AppError && e.code === "NOT_FOUND") notFound();
    throw e;
  });

  const owner = actor.isOwner ? (customer as CustomerOwnerDTO) : null;

  // The customer's own sale history, already role-scoped by the service.
  const [
    { sales },
    ledger,
    awardReasonThreshold,
    redemptions,
    whatsappReminderTemplate,
  ] = await Promise.all([
    listSales(actor, { customerId: id }),
    listCustomerLedger(actor, id, ledgerCursor),
    getTicketAwardReasonThreshold(),
    listRedemptions(actor, { customerId: id }),
    getCustomerWhatsAppReminderTemplate(),
  ]);
  const whatsappUrl = customerWhatsAppUrl(
    customer.phone,
    renderCustomerWhatsAppReminder(whatsappReminderTemplate, customer)
  );

  return (
    <div className="space-y-5">
      <Button variant="ghost" size="sm" render={<Link href="/customers" />}>
        <ArrowLeft className="size-4" />
        All customers
      </Button>

      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold tracking-tight">{customer.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {customer.phoneDisplay}
          </p>
        </div>
        <EditCustomer customer={customer} />
        {owner && <MergeCustomer winnerId={customer.id} winnerName={customer.name} />}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Marbles stored
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold tabular-nums">
              {customer.marbleBalance}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Tickets
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold tabular-nums">
              {customer.ticketBalance}
            </p>
          </CardContent>
        </Card>
      </div>

      <Button
        variant="outline"
        size="lg"
        className="w-full"
        render={
          <a href={whatsappUrl} target="_blank" rel="noreferrer" />
        }
      >
        <MessageCircle className="size-5" />
        Send WhatsApp reminder
      </Button>

      <Button
        size="xl"
        className="w-full"
        render={<Link href={`/customers/${customer.id}/redeem`} />}
      >
        <Gift className="size-5" />
        Redeem prizes
      </Button>

      <BalanceActions
        customerId={customer.id}
        canAdjust={
          actor.isOwner ||
          [...actor.shopRoles.values()].some((sr) => sr.role === "MANAGER")
        }
        awardReasonThreshold={awardReasonThreshold}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Balance history</CardTitle>
        </CardHeader>
        <CardContent>
          {ledger.entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">No balance activity yet.</p>
          ) : (
            <ul className="divide-y text-sm">
              {ledger.entries.map((entry) => (
                <li key={`${entry.kind}:${entry.id}`} className="flex gap-3 py-3">
                  <span
                    className={`min-w-16 font-bold tabular-nums ${
                      entry.delta > 0 ? "text-emerald-700" : "text-destructive"
                    }`}
                  >
                    {entry.delta > 0 ? "+" : ""}{entry.delta.toLocaleString("id-ID")}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">
                      {ledgerLabel(entry.kind, entry.type)}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {entry.shop.name} · {entry.recordedBy.displayName}
                      {entry.reason ? ` · ${entry.reason}` : ""}
                    </span>
                    {entry.redeemedItems && entry.redeemedItems.length > 0 && (
                      <span className="block text-xs text-muted-foreground">
                        {entry.redeemedItems
                          .map(
                            (item) =>
                              `${item.qty}× ${item.name} · ${item.ticketCostTotal.toLocaleString("id-ID")} tickets`
                          )
                          .join(", ")}
                      </span>
                    )}
                  </span>
                  <span className="text-right text-xs text-muted-foreground">
                    <span className="block tabular-nums">Balance {entry.balanceAfter.toLocaleString("id-ID")}</span>
                    <span className="block tabular-nums">{entry.businessDate}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {ledger.nextCursor && (
            <Button
              className="mt-4"
              variant="outline"
              render={<Link href={`/customers/${id}?ledgerCursor=${encodeURIComponent(ledger.nextCursor)}`} />}
            >
              Older activity
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Prize redemption history</CardTitle>
        </CardHeader>
        <CardContent>
          {redemptions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No prizes redeemed yet.</p>
          ) : (
            <ul className="divide-y text-sm">
              {redemptions.map((redemption) => (
                <li key={redemption.id} className="py-3">
                  <div className="flex gap-3">
                    <span
                      className={
                        redemption.isVoided
                          ? "font-medium text-muted-foreground line-through"
                          : "font-medium"
                      }
                    >
                      {redemption.isVoided ? "Tickets restored" : "Tickets spent"}
                    </span>
                    <span className="font-bold tabular-nums">
                      {redemption.isVoided ? "+" : "-"}
                      {redemption.totalTickets.toLocaleString("id-ID")}
                    </span>
                    <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                      {redemption.businessDate}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {redemption.lines
                      .map(
                        (line) =>
                          `${line.qty}× ${line.prizeName} · ${line.ticketCostTotal.toLocaleString("id-ID")} tickets`
                      )
                      .join(", ")}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {owner && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Spending</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4 text-sm">
            <Stat label="Total spend" value={formatMoney(owner.totalSpend)} />
            <Stat label="Sales" value={String(owner.saleCount)} />
            <Stat
              label="Average sale"
              value={owner.saleCount > 0 ? formatMoney(owner.averageSpend) : "—"}
            />
            <Stat label="Active days" value={String(owner.activeDays)} />
            <Stat
              label="Preferred shop"
              value={owner.preferredShop?.name ?? "—"}
            />
            <Stat
              label="Last seen"
              value={new Date(owner.lastSeenAt).toLocaleDateString("id-ID")}
            />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent sales</CardTitle>
        </CardHeader>
        <CardContent>
          {sales.length === 0 ? (
            <p className="text-sm text-muted-foreground">No sales yet.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {sales.slice(0, 20).map((sale) => (
                <li key={sale.id} className="flex items-center gap-3">
                  <span
                    className={
                      sale.status === "VOIDED"
                        ? "tabular-nums text-muted-foreground line-through"
                        : "font-medium tabular-nums"
                    }
                  >
                    {formatMoney(sale.amount)}
                  </span>
                  <span className="text-muted-foreground">
                    {sale.paymentMethod === "CASH" ? "Cash" : "Card"}
                  </span>
                  <span className="ml-auto text-muted-foreground tabular-nums">
                    {sale.businessDate}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ledgerLabel(kind: string, type: string): string {
  const labels: Record<string, string> = {
    "MARBLE:DEPOSIT": "Marbles deposited",
    "MARBLE:WITHDRAW": "Marbles withdrawn",
    "MARBLE:ADJUST": "Marble correction",
    "TICKET:AWARD": "Tickets awarded",
    "TICKET:ADJUST": "Ticket correction",
    "TICKET:REDEEM": "Tickets redeemed",
    "TICKET:VOID_RESTORE": "Tickets restored",
  };
  return labels[`${kind}:${type}`] ?? `${kind} ${type}`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-muted-foreground">{label}</p>
      <p className="mt-0.5 font-semibold">{value}</p>
    </div>
  );
}
