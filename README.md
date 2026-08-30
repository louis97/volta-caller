# Volta

**The AI operations partner for modern drayage.**

Volta coordinates carrier outreach, protects shipment constraints, and turns
carrier conversations into an auditable operational workflow. It is designed
to help logistics teams move faster without surrendering commercial control.

## Why Volta

Drayage coordination is often sequential and manual: teams call carriers one
at a time, compare notes outside their systems, and discover exceptions too
late. Volta brings that work into one controlled workflow.

- Faster carrier coordination
- Mandate-aware commercial execution
- Customer-controlled carrier selection
- Structured call summaries, prices, and agreement timestamps
- Early operational-risk visibility

## How it works

1. A dispatcher creates a shipment mandate in the dashboard: budget, route,
   pickup and delivery windows, and cargo requirements.
2. Volta contacts carriers and records their offers against that mandate.
3. Reviewed quotes appear in the dashboard for the customer to compare.
4. The customer selects the preferred quote.
5. Volta calls only that carrier back to confirm the exact selected terms.
6. The dashboard records the result, call history, and operational events.

Volta never selects a carrier or commits a booking during quote discovery. It
cannot exceed the recorded budget, change the shipment mandate, or accept an
unapproved exception.

## Operational safeguards

| Situation                                  | Volta's response                                                            |
| ------------------------------------------ | --------------------------------------------------------------------------- |
| Carrier proposes terms outside the mandate | Records the offer for audit; does not authorize it.                         |
| Customer has not selected a quote          | Does not place a booking call.                                              |
| Carrier changes terms during confirmation  | Fails safely; it does not renegotiate or substitute a carrier.              |
| Incident threatens the delivery deadline   | Captures structured facts, updates the dashboard, and escalates to a human. |

## Visibility

The dashboard provides a live pipeline, carrier call log, reviewed quotes,
final negotiated price and agreement time, transcript summary, and durable
notifications for quote readiness, confirmation outcomes, incidents, and
delivery-risk delays.

## Architecture

See the [Volta architecture diagram](docs/architecture.md) for the product
workflow, control boundaries, and integration points.

## Pilot with Nauta

Start with one high-volume lane and measure:

- Time from shipment release to reviewed quotes
- Coordinator time spent on carrier outreach
- Number of comparable offers per shipment
- Mandate violations prevented
- Confirmation success rate and early delivery-risk detection

## Local development

Requirements: Node.js 20+ and npm. PostgreSQL, Twilio, and OpenAI are optional
in mock mode.

```bash
npm install
cp .env.example .env
npm run dev
```

The API runs on `http://localhost:3001`; the dashboard is started by the
frontend workspace. For live carrier calls, configure the Twilio and OpenAI
variables in `.env` and expose the API with ngrok. See
[`docs/deploy-render-vercel.md`](docs/deploy-render-vercel.md) for deployment
guidance.

## Roadmap

WhatsApp is the planned inbound channel for mandate intake and incident
reporting. It will feed the same auditable operation and notification model;
it is not required for the current carrier-outreach workflow.

## Decision log

See [`docs/decision-log.md`](docs/decision-log.md) for the product decisions,
alternatives considered, and rationale.
