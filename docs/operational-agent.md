# Volta Operational Agent

The operational agent lives entirely in the Express backend. The dashboard creates a
conversation, posts questions, consumes readable tool activity plus the final SSE answer, and
renders evidence or proposed actions. OpenAI and database credentials are never sent to the
browser.

The central brain may read every operation persisted for the caller's organization, but mutating
proposals are limited to the operation currently active in the dispatch store. Its server-owned
tool registry can search records, inspect an operation, list attention items, compare quotes,
propose a carrier selection, and propose an already-authorized closing call. Read tools return
authorized evidence; proposal tools persist a `ProposedAction` and never execute it inline.

## Runtime

Set `DATABASE_URL` to enable the PostgreSQL repository. `npm run dev:api` loads the root `.env`,
and on first use the API applies every SQL file listed by its storage migrator. Supabase deployments
use the matching ordered files in `supabase/migrations`. Without a database the API uses the
in-memory repository, which is intended only for tests and mock development.

Set a newly generated `OPENAI_API_KEY` and optionally `VOLTA_COPILOT_MODEL`. The default is
`gpt-5.4-mini`, selected for the lower-latency conversational path while retaining Responses API,
function calling, and Structured Outputs. When the key is absent, mock mode uses the deterministic
grounded answerer so the retrieval and evidence path remains testable. Do not reuse credentials
shared in chat, logs, or source control.

Live requests to the agent require `x-volta-org-id` and `x-volta-user-id`, normally injected by the
authentication gateway. The deployed Next.js frontend uses its server-only catch-all API route to
inject `VOLTA_ORGANIZATION_ID` and `VOLTA_DASHBOARD_USER_ID`; browsers never choose those headers.
Internal ingestion additionally requires `x-volta-internal-key` matching `VOLTA_INTERNAL_API_KEY`.
Mock mode supplies a local organization and dispatcher identity.

## Public API

- `GET|POST /api/agent/conversations` lists or creates conversations.
- `GET /api/agent/conversations/:id` retrieves durable history.
- `PATCH /api/agent/conversations/:id` renames a conversation with `{ "title": "..." }`.
- `POST /api/agent/conversations/:id/messages` accepts `{ "question": "..." }` and returns SSE
  `activity`, `final`, or `error` events. Activity labels are user-facing summaries rather than
  raw tool arguments or results.
- `POST /api/agent/actions/:id/decision` accepts `{ "decision": "approve" | "decline" }`.
- `GET /api/evidence/:type/:id` resolves a citation within the caller's organization.
- `POST /api/internal/shipment-events` ingests the authoritative last-known shipment milestones.
- `POST /api/internal/transcript-segments` ingests speaker-attributed, timestamped transcripts.

An approved action is revalidated against the active operation ID and current operation version
before execution. Carrier selection additionally rechecks that the approval remains pending and
that the selected quote belongs to it. A stale proposal expires instead of executing against
changed terms.

## Retention and production rollout

The migration installs configurable defaults of 90 days for audio, 365 days for transcripts, and
1,825 days for audit records. The schema is ready for a scheduled retention worker; destructive
deletion should remain disabled until the organization approves its legal policy.

The managed PostgreSQL schema is provisioned in Supabase with RLS enabled and no public table
policies; the API accesses it through `DATABASE_URL` and the server-only service role. Before live
rollout, deploy the API as a persistent Node process compatible with SSE and WebSockets, provision
object storage, configure authentication headers at the gateway, rotate all exposed credentials,
and point `VOLTA_API_URL` in the frontend deployment to the API.
