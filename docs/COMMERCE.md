# Commerce architecture

Outlier remains the source of truth for offers, orders, customers, attribution and revenue history. A commerce provider handles checkout and payment processing. Provider IDs are references, never primary keys.

## Current foundation

Schema migration 2 adds:

- Commerce fields on `offers`, including integer minor-unit pricing and provider product/plan references.
- `customers` and `customer_identities` with provider identity mapping.
- `orders` created before checkout, with content, campaign and channel attribution.
- `subscriptions` for recurring access state.
- Append-only `revenue_events` for sales, refunds, fees and adjustments.
- `webhook_events` for durable provider-event deduplication and processing status.

The core service in `src/core/commerce.ts` validates offer pricing from the database, creates pending orders, attaches checkout references, records webhook deliveries and deduplicates revenue events.

## Whop phase 1

Whop is registered as the `commerce.primary` capability. The read-only connection test retrieves the configured company using the official SDK and supports the sandbox host:

- Sandbox API: `https://sandbox-api.whop.com/api/v1`
- Production API: `https://api.whop.com/api/v1`

Configure `WHOP_COMPANY_API_KEY`, `WHOP_COMPANY_ID` and optional `WHOP_SANDBOX` in `.env.local`. Keep `WHOP_WEBHOOK_SECRET` unset until a public webhook endpoint is deployed.

## Public boundary

The console is single-operator and localhost-first. A public checkout and Whop webhook cannot rely on the operator session or an intermittently running Windows machine.

The next slice must choose one of these boundaries:

1. Deploy the app behind HTTPS with a public webhook route.
2. Add a small public commerce bridge that stores verified events and syncs them into the local OS.
3. Use a local sandbox tunnel only for development acceptance testing.

Do not expose the operator console or disable its authentication merely to receive commerce webhooks.

## Next implementation slice

After the public boundary is chosen:

1. Create a server-side checkout route that reads price and Whop plan IDs from the offer, creates the local order first, and sends the order ID as checkout metadata.
2. Verify raw Whop webhook bodies and signatures before inserting `webhook_events`.
3. Process `payment.succeeded`, `payment.failed` and `refund.created` idempotently.
4. Reconcile payments periodically because webhooks provide timeliness while reconciliation provides correctness.
5. Add sandbox acceptance coverage before enabling production credentials.

Refunds do not automatically revoke Whop membership access; any access policy belongs in Outlier and must be explicit.
