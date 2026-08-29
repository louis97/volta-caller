# Volta Foundation Design

**Date:** 2026-08-29  
**Status:** Approved for planning

## Purpose

Volta is a hackathon prototype of an AI voice agent that coordinates container drayage for Textiles Pacífico from Manzanillo to Guadalajara. It must conduct and audit carrier negotiations while enforcing a non-negotiable operating mandate: a maximum of 9,000 MXN and a Thursday 10:00 AM pickup window.

The foundation supports four developers working in parallel on voice/telephony, agent logic, audit/state, and the demo dashboard. It is optimized for local development with ngrok and mock integrations first. Real Twilio and OpenAI Realtime connections are opt-in adapters, not prerequisites for every contributor.

## Architecture

The repository uses npm workspaces:

```text
volta-caller/
├── src/                   Express API, orchestration, Twilio/OpenAI adapters
├── frontend/              Next.js live dashboard and audit views
├── packages/contracts/    Shared typed domain models and events
├── tests/                 Unit and integration tests using mocks
├── docs/                  Runbooks, contracts, and team workflow
└── .github/               CI and pull-request templates
```

The root workspace hosts the TypeScript API. `frontend` is a separate Next.js workspace. `packages/contracts` is dependency-light and is the only shared source of domain types and event names. Its public API is additive during the hackathon to avoid breaking parallel branches.

## Domain Model and Invariants

Shared contracts define the following models:

- `Mandate`: operation route, maximum price, authorized pickup window, and escalation contact.
- `Operation`: container, shipper, destination, current status, mandate, and selected carrier.
- `Quote`: carrier, offered price, ETA, time window, call ID, and timestamp.
- `CallSession`: inbound or outbound call identity, carrier/driver, status, audio reference, and transcript metadata.
- `Commitment`: approved booking facts, agreement audio timestamp, recap status, and audit references.
- `CallBrief`: structured post-call summary of prices, objections, actions, and outcome.
- `Escalation`: reason, attempted terms, call context, and human hand-off state.

The API is the **sole authority** for operation state and mandate data. The dashboard may collect a
dispatcher’s input and render API read models, but it must not treat form state, local storage, or
an optimistic client object as an operational record. Agent tools request actions but cannot mutate
state without successful mandate validation. A commitment cannot be marked final until it has an
audio timestamp reference and a written-recap record.

### Mandate ingress and ownership

`POST /api/mandates` is the only ingress for a dispatcher-created mandate. It accepts this exact
dashboard payload, validates it at the HTTP boundary, and maps it to the canonical `Mandate` owned
by the API:

```json
{
  "budget_cap": 9000,
  "destination_datetime": "2026-09-03T18:00:00-06:00",
  "destination_place": "Textiles Pacífico, Guadalajara, Jalisco",
  "type_of_content": "Textiles",
  "weight": 18400,
  "measures": "120 × 100 × 110 cm",
  "pickup_address": "Terminal de Contenedores, Manzanillo, Colima",
  "pickup_datetime": "2026-09-03T10:00:00-06:00"
}
```

Both datetime fields require ISO 8601 offsets; the interface must provide an offset-preserving
adapter before it posts its `datetime-local` values. The API returns the canonical operation as the
read model and publishes `mandate.created`. Until durable storage is introduced, this authority is
an in-memory operation store; a process restart clears it, but the browser is never an alternative
source of truth.

## Runtime Flow

```text
Twilio call or local mock
  -> API call-session controller
  -> Realtime voice adapter
  -> typed agent-tool request
  -> mandate evaluator and operation store
  -> audit/recap service
  -> typed dashboard event
  -> Next.js live dashboard
```

The realtime adapter connects Twilio Media Streams and the OpenAI Realtime API for production-like sessions. In local demo mode, a deterministic mock call adapter emits the same typed events. The dashboard consumes API read models and live events; it never owns operational truth.

## Adapter Boundaries

- **Telephony adapter:** creates outbound calls, receives inbound webhooks, produces TwiML, relays media, and transfers an escalated call. A mock adapter simulates those actions.
- **Realtime adapter:** configures Spanish-speaking Volta instructions, server VAD, audio encoding, and typed tool-call handling. A mock adapter supports deterministic test scenarios.
- **State adapter:** defaults to an in-memory operation store. Its interface will permit Redis/Postgres replacement without changing mandate or audit logic.
- **Notification adapter:** defaults to an audit-visible mock SMS sender. The Twilio SMS implementation is enabled only when credentials are configured.

All adapters report typed failures. A failed external operation cannot convert an unapproved quote into a commitment.

## Mandate and Escalation

The mandate evaluator returns one of `APPROVED`, `REJECTED`, or `REQUIRES_ESCALATION`. It reads the
canonical backend `budgetCapMxn` and `pickupDatetime`, approves only prices at or below the cap and
the explicitly authorized pickup window, and escalates requests to exceed the cap, shift to an
unapproved day or time, or bypass the mandate through claimed verbal approval.

Agent tools are `check_mandate`, `register_quote`, `commit_deal`, and `trigger_escalation`. `commit_deal` repeats mandate validation immediately before recording a booking. Escalation creates a call brief and invokes the telephony transfer adapter without hanging up the call.

## Failure Handling

Unavailable carriers, invalid realtime messages, incomplete booking details, mandate conflicts, and recap delivery failures each produce an explicit operation status and call-brief entry. The system preserves the last known facts and requires retry or escalation; it never silently books a shipment or treats a transcript as a verified commitment.

## Local Developer Experience

The initial repository provides strict TypeScript, ESLint, Prettier, `.editorconfig`, `.env.example`, workspace scripts, seed data for three carrier candidates, and local ngrok/Twilio webhook instructions. Starting the API and dashboard requires no credentials in mock mode. The real adapters are selected only with explicit environment configuration.

## Testing and CI

The first test suite covers mandate evaluation, agent-tool execution, quote registration, commitment/recap creation, and the mock call lifecycle. Real Twilio/OpenAI calls are opt-in smoke tests and are excluded from default CI. GitHub Actions runs formatting, linting, typechecking, and unit tests for every pull request.

## Parallel Ownership

| Workstream | Primary scope |
| --- | --- |
| Voice and telephony | Twilio webhooks, media streams, barge-in/VAD, transfers, mock calling |
| Agent and mandate | Volta prompt, tools, strict validation, adversarial scenarios |
| State and audit | operation store, commitments, call briefs, audio references, recap adapters |
| Dashboard and demo | live calls, quote comparison, audit viewer, seeded demo scenario |

Each workstream depends on `packages/contracts` rather than another developer's internal module. Cross-workstream changes must update contracts and their tests together.

## Explicitly Deferred

Production authentication, durable database migrations, actual carrier integrations, production observability, and cloud deployment are deferred. The next implementation phase focuses on a fully demonstrable local mock workflow, then upgrades the telephony and realtime adapters for live calls.
