# Shipment Notifications Design

## Purpose

Give Textiles Pacífico an organization-wide operational notification feed in
the existing dashboard. Notifications must be durable, auditable, and visible
after a page refresh. The shipment-events table is the single source of truth.

## Scope

The initial release records and displays four Volta events:

1. A quote round is ready for client review after every expected carrier quote
   has been registered and reviewed.
2. A carrier confirms or denies the selected quote during Volta's confirmation
   call.
3. Volta receives a verified incident report during an exception call.
4. Volta assesses an incident as causing a delivery delay outside the mandate.

WhatsApp mandate intake, per-user read state, toasts, mobile push, and
notification preferences are out of scope. WhatsApp can later become another
producer of the same shipment events.

## Data and publication model

`ShipmentEvent` remains the canonical notification record. Each producer calls
one backend helper that creates an event with an operation ID, a stable event
type, a human-readable label, source, timestamps, and typed metadata. The
helper persists it through `AgentRepository.addShipmentEvent` before it
publishes `shipment.event.created` to the existing SSE stream.

Persistence before publication makes reconnects and page refreshes safe: the
frontend can always reload the persisted feed. The event message is an
incremental refresh signal rather than the only copy of notification data.

The API exposes `GET /api/shipment-events`. It returns the current
organization's events ordered by `occurredAt` descending. It must not expose
events from another organization. The existing dashboard proxy adds the
organization header as it does for other dashboard requests.

## Event taxonomy

The event types and required metadata are:

| Event type | Producer | Metadata |
| --- | --- | --- |
| `quotes_ready_for_review` | negotiation round completion | `quoteIds`, `carrierCount` |
| `carrier_confirmation_received` | confirmation tool result | `quoteId`, `carrierId`, `outcome` (`confirmed` or `denied`), optional `reason` |
| `incident_received` | exception tool result | `incidentId`, `category`, `callerName`, `revisedEta` |
| `delay_assessed` | central-brain incident assessment | `incidentId`, `revisedEta`, `destinationDeadline`, `escalationRequired` |

The notification card derives its title, tone, and icon from the event type;
the API does not store presentation decisions. The human-readable `label` is
the short summary and metadata supplies expandable details.

## Dashboard experience

The left navigation drawer gains a Notifications row using the established
icon, active-row, typography, and color patterns. Selecting it opens a
Notifications main view instead of changing the operation data model.

The view is organization-wide and newest first. Each card shows the event
icon, tone, label, operation identifier, and time. Expanding a card exposes
its metadata in readable labels and values, including a link/action to open
the associated operation. There is no read/unread state in this release.

On initial render the view fetches `GET /api/shipment-events`. While the
dashboard EventSource is connected, `shipment.event.created` causes a reload
of the feed. This uses the project’s existing SSE infrastructure and avoids
polling or a second live-connection type.

## Failure behavior

If persistence fails, no SSE notification is emitted; consumers never see a
non-auditable event. If publication fails after persistence, the event remains
available on the next fetch. If frontend fetching fails, the view retains its
last successful data and can retry through the next SSE signal or user
navigation.

## Testing

Backend tests cover event creation at all four sources, durable repository
writes, organization isolation, reverse chronological API output, and SSE
publication after persistence. Frontend tests cover the drawer row, the
organization-wide feed, event cards, expanded details, and SSE-driven refresh.
