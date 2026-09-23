import { describe, expect, it } from "vitest";
import { getDb } from "@/core/db";
import { addOffer, addProgram } from "@/core/commercial";
import { createPendingOrder, markWebhookProcessed, recordRevenueEvent, recordWebhookReceived } from "@/core/commerce";
import { BRAND, freshDb } from "./helpers";

describe("commerce foundation", () => {
  it("creates orders from database-owned integer pricing and deduplicates revenue events", () => {
    freshDb();
    const programId = addProgram(BRAND, { name: "Whop test program" }, "operator");
    const offerId = addOffer(BRAND, { programId, name: "Sales diagnostic" }, "operator");
    getDb().prepare("UPDATE offers SET offer_type='COMMERCE', price_minor=9900, price_currency='USD', commerce_provider='whop' WHERE id=?").run(offerId);

    const order = createPendingOrder({ offerId, contentId: "content_idea_001", channel: "test" });
    expect(order).toMatchObject({ status: "PENDING", amount_minor: 9900, currency: "USD", commerce_provider: "whop" });
    expect(recordRevenueEvent({ orderId: order.id, provider: "whop", providerEventId: "pay_test_1", eventType: "SALE", grossMinor: 9900, occurredAt: new Date().toISOString() })).toMatch(/^revenue_/);
    expect(recordRevenueEvent({ orderId: order.id, provider: "whop", providerEventId: "pay_test_1", eventType: "SALE", grossMinor: 9900, occurredAt: new Date().toISOString() })).toBe(recordRevenueEvent({ orderId: order.id, provider: "whop", providerEventId: "pay_test_1", eventType: "SALE", grossMinor: 9900, occurredAt: new Date().toISOString() }));
    expect((getDb().prepare("SELECT status FROM orders WHERE id=?").get(order.id) as { status: string }).status).toBe("PAID");
  });

  it("stores webhook deliveries once and allows processing status to be recorded", () => {
    freshDb();
    expect(recordWebhookReceived({ provider: "whop", eventId: "evt_1", eventType: "payment.succeeded", payload: { id: "pay_1" } }).firstDelivery).toBe(true);
    expect(recordWebhookReceived({ provider: "whop", eventId: "evt_1", eventType: "payment.succeeded", payload: { id: "pay_1" } }).firstDelivery).toBe(false);
    markWebhookProcessed("evt_1", "PROCESSED");
    expect((getDb().prepare("SELECT processing_status FROM webhook_events WHERE provider_event_id='evt_1'").get() as { processing_status: string }).processing_status).toBe("PROCESSED");
  });
});
