# Volta architecture

This diagram describes the current product workflow. The customer remains the
commercial decision-maker; Volta automates coordination within the recorded
mandate.

```mermaid
flowchart LR
  subgraph Customer[Textiles Pacífico / Nauta customer]
    Dashboard[Operations dashboard]
    Selection[Select reviewed quote]
  end

  subgraph Volta[Volta operations platform]
    API[API and workflow orchestration]
    Mandate[Mandate guardrails]
    Agent[Volta voice agent]
    Confirm[Confirmation coordinator]
    Events[Audit trail and notifications]
    Store[(Operations, quotes, transcripts, events)]
  end

  subgraph CarrierNetwork[Carrier network]
    Carriers[Transport providers]
  end

  Dashboard -->|Shipment mandate| API
  API --> Mandate
  Mandate -->|Authorized carrier outreach| Agent
  Agent <-->|Voice calls| Carriers
  Agent -->|Quotes and call summaries| Store
  Store -->|Reviewed quotes| Dashboard
  Dashboard --> Selection
  Selection -->|Explicit approval| Confirm
  Confirm -->|Confirm exact selected terms| Carriers
  Confirm --> Store
  Store --> Events
  Events -->|Live status and alerts| Dashboard

  WhatsApp[WhatsApp intake<br/>future integration] -.->|Mandates and incidents| API
```

## Control boundary

Volta may collect offers and confirm an explicitly selected carrier. It may not
select a carrier, alter the mandate, accept changed terms, or make an
unapproved booking. Conditions outside the mandate create an auditable failure
or escalation for a human decision.

## Core integrations

| Integration      | Role                                                                          |
| ---------------- | ----------------------------------------------------------------------------- |
| Dashboard        | Creates mandates, exposes quotes, receives selection and alerts.              |
| Telephony        | Places carrier outreach and confirmation calls.                               |
| AI services      | Runs voice dialogue and extracts structured call outcomes.                    |
| Operations store | Persists mandates, calls, quotes, transcripts, selections, and notifications. |
| WhatsApp         | Planned inbound channel for mandates and incidents.                           |
