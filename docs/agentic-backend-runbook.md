# Volta agentic backend runbook

This runbook describes the safety boundaries for Volta's three call modes and
the dashboard-to-callback handoff. The operation store is authoritative for
mandates, quotes, selections, incidents, and commitments.

## Call modes

- **Negotiation** requests factual carrier quotes, checks each quote against
  the mandate, registers the quote, and reviews it for dashboard selection.
  It may escalate pressure or an unsupported exception, but it cannot create a
  commitment or bypass the mandate.
- **Confirmation** handles one client-selected quote. It repeats the selected
  terms and can finalize only when the carrier confirms every term unchanged.
  Changed terms, unavailable capacity, expired selections, and callback
  failures produce a failure brief; Volta does not renegotiate or substitute a
  carrier.
- **Exception** handles an inbound operational incident. The backend preloads
  an immutable mandate and relevant operation context before the conversation,
  then exposes only durable write and escalation tools. It never books,
  selects, renegotiates, or changes the mandate during the call.

## Client selection and callback

The dashboard submits the selected reviewed quote to:

```http
POST /operations/:id/select-quote
Content-Type: application/json

{"quoteId":"quote-costa-pacifico-001"}
```

The backend validates operation ownership, review approval, mandate
compliance, and selection expiry before placing a callback. Expected responses:

| Status            | Meaning                                                                   |
| ----------------- | ------------------------------------------------------------------------- |
| `202 Accepted`    | Selection persisted and one confirmation callback started.                |
| `400 Bad Request` | Request body is malformed or missing `quoteId`.                           |
| `404 Not Found`   | The operation ID is not the active operation.                             |
| `409 Conflict`    | Selection is expired, unreviewed, out of mandate, or already in progress. |
| `502 Bad Gateway` | The selected carrier is unavailable or callback creation failed.          |

No non-202 response starts telephony. A successful callback is the only path
to confirmation, and a commitment is not written until exact-term validation
and recap handling succeed.

## Exception information checklist

Capture and validate these facts before recording an incident:

- verified caller identity;
- carrier and truck (including the known plate when available);
- operation ID and current process stage;
- issue description;
- reported delay in minutes; and
- revised ETA.

For an achievable ETA, record the incident and continue operational
monitoring. For an ETA after the destination deadline, record the incident and
notify the dashboard once, then escalate as needed. An unmatched caller or
carrier/truck does not mutate the operation or notify the dashboard.

## Audit and urgent decisions

Call audio and transcripts are audit artifacts used for call briefs and
post-call review. They are not the sole source of urgent operational
decisions: live, schema-validated tool calls drive mandate checks, callback
confirmation, incident recording, status updates, dashboard notifications,
and escalation. Exception calls use their preloaded context instead of making
read or assessment calls while the caller waits.
