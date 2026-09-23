import { getDb, tx } from "./db";
import { audit } from "./audit";
import { getOffer } from "./commercial";
import { AppError, assert, newId, nowIso } from "./util";

export type CommerceOrderStatus = "PENDING" | "PAID" | "FAILED" | "REFUNDED" | "PARTIALLY_REFUNDED" | "DISPUTED" | "CANCELLED";
export type RevenueEventType = "SALE" | "REFUND" | "FEE" | "ADJUSTMENT";

export interface OrderRow {
  id: string;
  brand_id: string;
  offer_id: string;
  customer_id: string | null;
  content_id: string | null;
  campaign_id: string | null;
  channel: string | null;
  status: CommerceOrderStatus;
  amount_minor: number;
  currency: string;
  commerce_provider: string;
  provider_checkout_id: string | null;
  provider_payment_id: string | null;
  checkout_url: string | null;
  created_at: string;
  paid_at: string | null;
  refunded_at: string | null;
  updated_at: string;
}

export function getOrder(id: string): OrderRow {
  const order = getDb().prepare("SELECT * FROM orders WHERE id=?").get(id) as OrderRow | undefined;
  if (!order) throw new AppError("NOT_FOUND", `Order ${id} not found`, 404);
  return order;
}

export function createPendingOrder(input: {
  offerId: string;
  contentId?: string | null;
  campaignId?: string | null;
  channel?: string | null;
}): OrderRow {
  const offer = getOffer(input.offerId) as typeof getOffer extends (id: string) => infer T ? T & {
    offer_type?: string;
    price_minor?: number | null;
    price_currency?: string | null;
    commerce_provider?: string | null;
  } : never;
  assert(offer.offer_type === "COMMERCE", "NOT_COMMERCE_OFFER", "This offer is not configured for commerce checkout.");
  assert(offer.commerce_provider, "COMMERCE_PROVIDER_MISSING", "This offer has no commerce provider configured.");
  const priceMinor = offer.price_minor;
  const priceCurrency = offer.price_currency;
  assert(Number.isInteger(priceMinor) && (priceMinor ?? 0) > 0, "OFFER_PRICE_MISSING", "Commerce offers need a positive integer price in minor currency units.");
  assert(priceCurrency && /^[A-Z]{3}$/.test(priceCurrency), "OFFER_CURRENCY_MISSING", "Commerce offers need a three-letter currency code.");

  const id = newId("order");
  const now = nowIso();
  getDb()
    .prepare(
      `INSERT INTO orders (id, brand_id, offer_id, content_id, campaign_id, channel, status, amount_minor, currency, commerce_provider, created_at, updated_at)
       VALUES (?,?,?,?,?,?, 'PENDING', ?,?,?,?,?)`,
    )
    .run(id, offer.brand_id, offer.id, input.contentId ?? null, input.campaignId ?? null, input.channel ?? null, priceMinor, priceCurrency, offer.commerce_provider, now, now);
  audit({ actor: "system", action: "commerce.order.create", subjectType: "order", subjectId: id, brandId: offer.brand_id, summary: `Pending ${offer.commerce_provider} order ${id} created for ${offer.name}` });
  return getOrder(id);
}

export function attachCheckout(orderId: string, providerCheckoutId: string, checkoutUrl: string | null) {
  assert(providerCheckoutId.trim().length > 0, "BAD_PROVIDER_ID", "A provider checkout ID is required.");
  getOrder(orderId);
  getDb().prepare("UPDATE orders SET provider_checkout_id=?, checkout_url=?, updated_at=? WHERE id=? AND status='PENDING'").run(providerCheckoutId, checkoutUrl, nowIso(), orderId);
  return getOrder(orderId);
}

export function recordWebhookReceived(input: { provider: string; eventId: string; eventType: string; payload: unknown }) {
  assert(input.eventId.trim().length > 0, "BAD_PROVIDER_EVENT", "A provider event ID is required.");
  const existing = getDb().prepare("SELECT processing_status FROM webhook_events WHERE provider_event_id=?").get(input.eventId) as { processing_status: string } | undefined;
  if (existing) return { firstDelivery: false, status: existing.processing_status };
  getDb()
    .prepare(
      `INSERT INTO webhook_events (provider_event_id, provider, event_type, payload_json, received_at, processing_status)
       VALUES (?,?,?,?,?,'RECEIVED')`,
    )
    .run(input.eventId, input.provider, input.eventType, JSON.stringify(input.payload), nowIso());
  return { firstDelivery: true, status: "RECEIVED" };
}

export function markWebhookProcessed(eventId: string, status: "PROCESSED" | "IGNORED" | "FAILED", errorMessage?: string) {
  getDb().prepare("UPDATE webhook_events SET processing_status=?, processed_at=?, error_message=? WHERE provider_event_id=?").run(status, nowIso(), errorMessage ?? null, eventId);
}

export function recordRevenueEvent(input: {
  orderId: string;
  provider: string;
  providerEventId: string;
  eventType: RevenueEventType;
  grossMinor: number;
  feeMinor?: number | null;
  netMinor?: number | null;
  occurredAt: string;
}) {
  const order = getOrder(input.orderId);
  const existing = getDb().prepare("SELECT id FROM revenue_events WHERE provider=? AND provider_event_id=?").get(input.provider, input.providerEventId) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = newId("revenue");
  tx(() => {
    getDb()
      .prepare(
        `INSERT INTO revenue_events (id, order_id, customer_id, offer_id, provider, provider_event_id, event_type, gross_minor, fee_minor, net_minor, currency, occurred_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, order.id, order.customer_id, order.offer_id, input.provider, input.providerEventId, input.eventType, input.grossMinor, input.feeMinor ?? null, input.netMinor ?? null, order.currency, input.occurredAt, nowIso());
    if (input.eventType === "SALE")
      getDb().prepare("UPDATE orders SET status='PAID', provider_payment_id=?, paid_at=COALESCE(paid_at,?), updated_at=? WHERE id=? AND status='PENDING'").run(input.providerEventId, input.occurredAt, nowIso(), order.id);
    if (input.eventType === "REFUND") getDb().prepare("UPDATE orders SET status='REFUNDED', refunded_at=COALESCE(refunded_at,?), updated_at=? WHERE id=?").run(input.occurredAt, nowIso(), order.id);
  });
  audit({ actor: "system", action: `commerce.revenue.${input.eventType.toLowerCase()}`, subjectType: "order", subjectId: order.id, brandId: order.brand_id, summary: `${input.eventType} recorded for ${order.id}: ${input.grossMinor} ${order.currency}` });
  return id;
}
