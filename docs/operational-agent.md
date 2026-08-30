# Volta Operational Agent

The operational agent lives entirely in the Express backend. The dashboard creates a
conversation, posts questions, consumes the SSE answer, and renders evidence or proposed actions.
OpenAI and database credentials are never sent to the browser.

## Runtime

Set `DATABASE_URL` to enable the PostgreSQL repository. On first use, the API applies
`src/storage/migrations/001_agent_knowledge.sql`. Without a database the API uses the in-memory
repository, which is intended only for tests and mock development.

Set a newly generated `OPENAI_API_KEY` and optionally `VOLTA_COPILOT_MODEL`. When the key is absent,
mock mode uses the deterministic grounded answerer so the retrieval and evidence path remains
testable. Do not reuse credentials shared in chat, logs, or source control.

Live requests to the agent require `x-volta-org-id` and `x-volta-user-id`, normally injected by the
authentication gateway. The deployed Next.js frontend uses its server-only catch-all API route to
inject `VOLTA_ORGANIZATION_ID` and `VOLTA_DASHBOARD_USER_ID`; browsers never choose those headers.
Internal ingestion additionally requires `x-volta-internal-key` matching `VOLTA_INTERNAL_API_KEY`.
Mock mode supplies a local organization and dispatcher identity.

## Public API

- `GET|POST /api/agent/conversations` lists or creates conversations.
- `GET /api/agent/conversations/:id` retrieves durable history.
- `POST /api/agent/conversations/:id/messages` accepts `{ "question": "..." }` and returns SSE
  `status`, `final`, or `error` events.
- `POST /api/agent/actions/:id/decision` accepts `{ "decision": "approve" | "decline" }`.
- `GET /api/evidence/:type/:id` resolves a citation within the caller's organization.
- `POST /api/internal/shipment-events` ingests the authoritative last-known shipment milestones.
- `POST /api/internal/transcript-segments` ingests speaker-attributed, timestamped transcripts.

An approved action is revalidated against the current operation version before execution. A stale
proposal expires instead of executing against changed terms.

## Retention and production rollout

The migration installs configurable defaults of 90 days for audio, 365 days for transcripts, and
1,825 days for audit records. The schema is ready for a scheduled retention worker; destructive
deletion should remain disabled until the organization approves its legal policy.

Before live rollout, deploy the API as a persistent Node process compatible with SSE and WebSockets,
provision PostgreSQL and object storage, configure authentication headers at the gateway, rotate all
exposed credentials, and point `VOLTA_API_URL` in the frontend deployment to the API.
