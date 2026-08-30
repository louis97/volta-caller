# Quote Transcript Extraction Design

## Goal

Persist a display-only structured extraction for each completed carrier call and
show the final agreed price, currency, and agreement timestamp in Pipeline.

## Entity

`quote_extractions` has one current record per organization/call: IDs for the
organization, operation, call, and optional quote; nullable `final_price_mxn`,
`currency`, `agreed_at`, and transcript millisecond evidence; status
(`pending`, `completed`, `unavailable`, `failed`); model and timestamps.

## Flow

When a carrier call completes and transcript persistence is available, the
backend creates `pending`, sends transcript text and segment timing to the
existing server-side OpenAI structured-output pattern using `OPENAI_API_KEY`
and `VOLTA_QUOTE_EXTRACTION_MODEL`, validates the three fields, persists the
result, and publishes `quote.extraction.updated` through existing SSE.

The pipeline fetches extraction records and displays them beside the matching
call/quote. Extractions never alter quotes, mandates, selections, or bookings.
An unclear transcript is stored as `unavailable`, not guessed.
