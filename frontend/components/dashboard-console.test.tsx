import "@testing-library/jest-dom/vitest";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within
} from "@testing-library/react";
import type { Operation } from "@volta/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { seedOperation, THURSDAY_PICKUP } from "../../src/core/seed";
import { DashboardConsole } from "./dashboard-console";

afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

function openNavigationItem(name: string) {
  fireEvent.click(
    within(screen.getByRole("navigation")).getByRole("button", {
      name: new RegExp(name)
    })
  );
}

describe("DashboardConsole", () => {
  it("navigates between mandate creation and approvals", async () => {
    render(<DashboardConsole />);

    expect(
      screen.getByRole("heading", { name: "New mandate", level: 1 })
    ).toBeInTheDocument();

    openNavigationItem("Approvals");
    expect(
      await screen.findByRole("heading", { name: "Approvals", level: 1 })
    ).toBeInTheDocument();
  });

  it("opens the contextual copilot from every dispatch view", async () => {
    render(<DashboardConsole />);

    fireEvent.click(screen.getByRole("button", { name: "Ask Volta" }));
    const copilot = await screen.findByRole("complementary", {
      name: "Volta Copilot"
    });
    expect(
      within(copilot).getByText(
        "Backend agent grounded in operational records. Every factual answer links to its evidence; actions wait for your approval."
      )
    ).toBeInTheDocument();
  });

  it("creates a backend conversation and renders navigable evidence", async () => {
    const finalMessage = {
      id: "assistant-001",
      conversationId: "conversation-001",
      role: "assistant",
      content: "The shipment is still at the origin terminal.",
      citations: [
        {
          id: "shipment_event:event-001",
          sourceType: "shipment_event",
          sourceId: "event-001",
          operationId: "operation-001",
          title: "Carga en origen",
          excerpt: "at_origin en Manzanillo",
          occurredAt: "2026-09-01T15:00:00.000Z",
          href: "/api/evidence/shipment_event/event-001"
        }
      ],
      proposedActions: [],
      createdAt: "2026-09-01T15:00:01.000Z"
    };
    const stream = [
      'event: status\ndata: {"stage":"retrieving"}\n\n',
      `event: final\ndata: ${JSON.stringify(finalMessage)}\n\n`
    ].join("");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => []
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "conversation-001" })
      })
      .mockResolvedValueOnce(
        new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        })
      );
    vi.stubGlobal("fetch", fetchMock);
    render(<DashboardConsole />);

    fireEvent.click(screen.getByRole("button", { name: "Ask Volta" }));
    fireEvent.change(
      await screen.findByLabelText("Ask across operational history"),
      {
        target: { value: "Where is the shipment?" }
      }
    );
    await vi.waitFor(() =>
      expect(
        within(
          screen.getByRole("complementary", { name: "Volta Copilot" })
        ).getByRole("button", { name: "Ask Volta" })
      ).toBeEnabled()
    );
    fireEvent.click(
      within(
        screen.getByRole("complementary", { name: "Volta Copilot" })
      ).getByRole("button", { name: "Ask Volta" })
    );

    expect(
      await screen.findByText("The shipment is still at the origin terminal.")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Carga en origen" })
    ).toHaveAttribute("href", "/api/evidence/shipment_event/event-001");
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/agent/conversations/conversation-001/messages",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("posts the complete mandate to the API before showing it as created", async () => {
    const { container } = render(<DashboardConsole />);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "operation-mandate-1" })
    });
    vi.stubGlobal("fetch", fetchMock);

    await screen.findByRole("button", { name: "Launch mandate" });

    const expectedManifestFields = [
      "budget_cap",
      "destination_datetime",
      "destination_place",
      "type_of_content",
      "weight",
      "measures",
      "pickup_address",
      "pickup_datetime"
    ];

    expect(
      Array.from(container.querySelectorAll("input[name], select[name]")).map(
        (field) => field.getAttribute("name")
      )
    ).toEqual(expect.arrayContaining(expectedManifestFields));
    expect(
      container.querySelectorAll("input[name], select[name]")
    ).toHaveLength(expectedManifestFields.length);

    fireEvent.change(
      screen.getByRole("combobox", { name: "Type of content" }),
      {
        target: { value: "textiles" }
      }
    );
    fireEvent.change(screen.getByRole("spinbutton", { name: "Weight KG" }), {
      target: { value: "18400" }
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Measures" }), {
      target: { value: "120 × 100 × 110 cm" }
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Pickup address" }), {
      target: { value: "Terminal de Contenedores, Manzanillo, Colima" }
    });
    fireEvent.change(screen.getByLabelText("Pickup date & time"), {
      target: { value: "2026-09-03T10:00" }
    });
    fireEvent.change(screen.getByLabelText("Destination date & time"), {
      target: { value: "2026-09-03T18:00" }
    });
    fireEvent.change(
      screen.getByRole("textbox", { name: "Destination place" }),
      {
        target: { value: "Textiles Pacífico, Guadalajara, Jalisco" }
      }
    );
    fireEvent.change(
      screen.getByRole("spinbutton", { name: "Budget cap MXN" }),
      {
        target: { value: "9000" }
      }
    );
    fireEvent.click(screen.getByRole("button", { name: "Launch mandate" }));

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/mandates",
        expect.objectContaining({ method: "POST" })
      );
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      budget_cap: 9000,
      destination_datetime: "2026-09-03T18:00:00-06:00",
      destination_place: "Textiles Pacífico, Guadalajara, Jalisco",
      type_of_content: "textiles",
      weight: 18400,
      measures: "120 × 100 × 110 cm",
      pickup_address: "Terminal de Contenedores, Manzanillo, Colima",
      pickup_datetime: "2026-09-03T10:00:00-06:00"
    });
    expect(
      await screen.findByText("Mandate operation-mandate-1 created")
    ).toBeInTheDocument();
  });

  it("keeps the mandate unsaved when the API rejects it", async () => {
    render(<DashboardConsole />);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) })
    );

    fireEvent.change(
      screen.getByRole("combobox", { name: "Type of content" }),
      {
        target: { value: "textiles" }
      }
    );
    fireEvent.change(screen.getByRole("spinbutton", { name: "Weight KG" }), {
      target: { value: "18400" }
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Measures" }), {
      target: { value: "120 × 100 × 110 cm" }
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Pickup address" }), {
      target: { value: "Terminal de Contenedores, Manzanillo, Colima" }
    });
    fireEvent.change(screen.getByLabelText("Pickup date & time"), {
      target: { value: "2026-09-03T10:00" }
    });
    fireEvent.change(screen.getByLabelText("Destination date & time"), {
      target: { value: "2026-09-03T18:00" }
    });
    fireEvent.change(
      screen.getByRole("textbox", { name: "Destination place" }),
      {
        target: { value: "Textiles Pacífico, Guadalajara, Jalisco" }
      }
    );
    fireEvent.change(
      screen.getByRole("spinbutton", { name: "Budget cap MXN" }),
      {
        target: { value: "9000" }
      }
    );
    fireEvent.click(screen.getByRole("button", { name: "Launch mandate" }));

    expect(
      await screen.findByText(/Volta could not save this mandate/)
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Launch mandate" })
    ).toBeInTheDocument();
  });

  it("shows the API connection state for live approvals", async () => {
    render(<DashboardConsole />);

    openNavigationItem("Approvals");
    expect(
      await screen.findByRole("heading", {
        name: "Approvals are served by the dispatch API."
      })
    ).toBeInTheDocument();
  });

  it("requires a carrier selection before authorizing the closing call", async () => {
    const operation = quoteRoundOperation();
    const fetchMock = vi.fn().mockImplementation(async (input: string) => {
      if (input === "/api/operation") {
        return { ok: true, json: async () => structuredClone(operation) };
      }
      if (input.includes("/decision")) {
        operation.approvals[0] = {
          ...operation.approvals[0],
          status: "approved",
          selectedQuoteId: "quote-ruta-occidente-001",
          decidedBy: "Bryan Riano"
        };
        operation.commitment = {
          id: "commitment-001",
          carrierId: "carrier-ruta-occidente",
          callId: "close-call-001",
          finalPriceMxn: 8500,
          pickupTime: THURSDAY_PICKUP,
          audioTimestampUrl: "/audio/recordings/close-call-001#t=42.5",
          recapStatus: "sent",
          recapMessageId: "sms-001",
          finalizedAt: "2026-09-01T15:05:00.000Z"
        };
        return {
          ok: true,
          json: async () => ({ operation: structuredClone(operation) })
        };
      }
      throw new Error(`Unexpected request: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<DashboardConsole />);

    openNavigationItem("Approvals");
    await screen.findByText("3 carrier quotes are ready to compare");

    fireEvent.click(
      screen.getByRole("button", { name: "Authorize closing call" })
    );
    expect(await screen.findByText(/Select one carrier/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: /Ruta Occidente/ }));
    fireEvent.click(
      screen.getByRole("button", { name: "Authorize closing call" })
    );

    expect(
      await screen.findByText("Carrier booking confirmed")
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/approvals/approval-quote-round-001/decision",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("reopens the quote round when the dispatcher undoes an uncommitted decision", async () => {
    const operation = quoteRoundOperation();
    const fetchMock = vi.fn().mockImplementation(async (input: string) => {
      if (input === "/api/operation") {
        return { ok: true, json: async () => structuredClone(operation) };
      }
      if (input.includes("/decision")) {
        operation.approvals[0] = {
          ...operation.approvals[0],
          status: "approved",
          selectedQuoteId: "quote-ruta-occidente-001",
          decidedBy: "Bryan Riano"
        };
        operation.status = "negotiating";
        operation.closingAuthorization = {
          approvalId: operation.approvals[0].id,
          quoteId: "quote-ruta-occidente-001",
          carrierId: "carrier-ruta-occidente",
          finalPriceMxn: 8500,
          pickupTime: THURSDAY_PICKUP,
          authorizedBy: "Bryan Riano",
          authorizedAt: "2026-09-01T15:02:00.000Z"
        };
        return {
          ok: true,
          json: async () => ({ operation: structuredClone(operation) })
        };
      }
      if (input.includes("/undo")) {
        operation.approvals[0] = {
          ...operation.approvals[0],
          status: "pending",
          selectedQuoteId: undefined,
          decidedBy: undefined
        };
        operation.status = "awaiting_approval";
        operation.closingAuthorization = undefined;
        return {
          ok: true,
          json: async () => ({ operation: structuredClone(operation) })
        };
      }
      throw new Error(`Unexpected request: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<DashboardConsole />);

    openNavigationItem("Approvals");
    await screen.findByText("3 carrier quotes are ready to compare");
    fireEvent.click(screen.getByRole("radio", { name: /Ruta Occidente/ }));
    fireEvent.click(
      screen.getByRole("button", { name: "Authorize closing call" })
    );

    expect(
      await screen.findByText(/Closing call authorized/)
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Undo decision" }));

    expect(
      await screen.findByText("3 carrier quotes are ready to compare")
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/approvals/approval-quote-round-001/undo",
      expect.objectContaining({ method: "POST" })
    );
  });
});

function quoteRoundOperation(): Operation {
  const operation = seedOperation();
  operation.status = "awaiting_approval";
  operation.quotes = [
    {
      id: "quote-costa-pacifico-001",
      carrierId: "carrier-costa-pacifico",
      carrierName: "Transportes Costa Pacífico",
      priceMxn: 8750,
      etaMinutes: 90,
      pickupTime: THURSDAY_PICKUP,
      callId: "call-costa",
      createdAt: "2026-09-01T15:00:00.000Z"
    },
    {
      id: "quote-ruta-occidente-001",
      carrierId: "carrier-ruta-occidente",
      carrierName: "Ruta Occidente",
      priceMxn: 8500,
      etaMinutes: 75,
      pickupTime: THURSDAY_PICKUP,
      callId: "call-ruta",
      createdAt: "2026-09-01T15:00:00.000Z"
    },
    {
      id: "quote-logistica-manzanillo-001",
      carrierId: "carrier-logistica-manzanillo",
      carrierName: "Logística Manzanillo",
      priceMxn: 8640,
      etaMinutes: 80,
      pickupTime: THURSDAY_PICKUP,
      callId: "call-logistica",
      createdAt: "2026-09-01T15:00:00.000Z"
    }
  ];
  operation.approvals = [
    {
      id: "approval-quote-round-001",
      operationId: operation.id,
      type: "carrier_selection",
      status: "pending",
      quoteIds: operation.quotes.map((quote) => quote.id),
      recommendedQuoteId: "quote-ruta-occidente-001",
      createdAt: "2026-09-01T15:01:00.000Z"
    }
  ];
  return operation;
}
