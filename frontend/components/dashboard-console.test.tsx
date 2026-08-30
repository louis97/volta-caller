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

  it("shows persisted organization notifications from the drawer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () =>
          url === "/api/shipment-events"
            ? [
                {
                  id: "notification-001",
                  organizationId: "textiles-pacifico",
                  operationId: "operation-001",
                  type: "quotes_ready_for_review",
                  label: "Carrier quotes are ready for review.",
                  source: "volta",
                  occurredAt: "2026-08-30T10:00:00.000Z",
                  receivedAt: "2026-08-30T10:00:00.000Z",
                  metadata: { carrierCount: 3 }
                }
              ]
            : seedOperation()
      }))
    );
    render(<DashboardConsole />);

    openNavigationItem("Notifications");

    expect(
      await screen.findByRole("heading", { name: "Notifications", level: 1 })
    ).toBeInTheDocument();
    expect(
      await screen.findByText("Carrier quotes are ready for review.")
    ).toBeVisible();
  });

  it("opens calls, pipeline, carriers, approvals and notifications in their mandate context", async () => {
    const first = { ...seedOperation(), pipelineStage: "open" as const };
    const secondBase = quoteRoundOperation();
    const second = {
      ...secondBase,
      id: "operation-mandate-santa-marta-002",
      origin: "Santa Marta",
      destination: "Medellín",
      pipelineStage: "awaiting_approval" as const,
      callSessions: [
        {
          id: "call-santa-marta",
          operationId: "operation-mandate-santa-marta-002",
          carrierId: "carrier-ruta-occidente",
          direction: "outbound" as const,
          status: "completed" as const,
          quoteId: "quote-ruta-occidente-001",
          startedAt: "2026-08-30T08:00:00.000Z",
          endedAt: "2026-08-30T08:02:00.000Z"
        }
      ],
      approvals: secondBase.approvals.map((approval) => ({
        ...approval,
        operationId: "operation-mandate-santa-marta-002"
      }))
    };
    const operations = [first, second];
    const fetchMock = vi.fn().mockImplementation(async (input: string) => {
      if (input === "/api/operations") {
        return { ok: true, json: async () => structuredClone(operations) };
      }
      if (input.startsWith("/api/operations/")) {
        const id = decodeURIComponent(input.replace("/api/operations/", ""));
        return {
          ok: true,
          json: async () =>
            structuredClone(operations.find((item) => item.id === id))
        };
      }
      if (input === "/api/operation") {
        return { ok: true, json: async () => structuredClone(first) };
      }
      if (input === "/api/transcript") {
        return { ok: true, json: async () => [] };
      }
      if (input === "/api/carriers") {
        return {
          ok: true,
          json: async () => [
            {
              id: "carrier-ruta-occidente",
              name: "Ruta Occidente",
              phone: "+573142117112",
              lanes: ["Santa Marta → Medellín"],
              active: true
            }
          ]
        };
      }
      if (input === "/api/shipment-events") {
        return {
          ok: true,
          json: async () => [
            {
              id: "event-santa-marta",
              organizationId: "textiles-pacifico",
              operationId: second.id,
              type: "quotes_ready_for_review",
              label: "Quotes ready for Santa Marta mandate",
              source: "volta",
              occurredAt: "2026-08-30T08:03:00.000Z",
              receivedAt: "2026-08-30T08:03:00.000Z"
            }
          ]
        };
      }
      throw new Error(`Unexpected request: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<DashboardConsole />);

    openNavigationItem("Pipeline");
    const pipelineDeck = await screen.findByRole("region", {
      name: "Pipeline by mandate"
    });
    fireEvent.click(
      within(pipelineDeck).getByRole("button", {
        name: /Santa Marta.*Medellín/
      })
    );
    await vi.waitFor(() =>
      expect(screen.getByLabelText("Active mandate")).toHaveValue(second.id)
    );
    expect(
      (await screen.findAllByText("Santa Marta → Medellín")).length
    ).toBeGreaterThan(0);

    openNavigationItem("Carriers");
    fireEvent.click(await screen.findByTitle("Santa Marta → Medellín"));
    expect(
      await screen.findByRole("heading", { name: "Call floor", level: 1 })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Call groups by mandate" })
    ).toBeInTheDocument();

    openNavigationItem("Approvals");
    expect(
      await screen.findByText(/Mandate santa-ma.*Santa Marta → Medellín/i)
    ).toBeInTheDocument();

    openNavigationItem("Notifications");
    fireEvent.click(
      await screen.findByText("Quotes ready for Santa Marta mandate")
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Open mandate/ })
    );
    expect(
      await screen.findByRole("heading", { name: "Pipeline", level: 1 })
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Active mandate")).toHaveValue(second.id);
  });

  it("opens Volta as a primary workspace instead of a drawer", async () => {
    const operation = { ...seedOperation(), pipelineStage: "open" };
    const fetchMock = vi.fn().mockImplementation(async (input: string) => {
      if (input === "/api/operation") {
        return { ok: true, json: async () => operation };
      }
      if (input === "/api/agent/conversations") {
        return { ok: true, json: async () => [] };
      }
      throw new Error(`Unexpected request: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<DashboardConsole />);

    openNavigationItem("Volta");
    const workspace = await screen.findByRole("region", {
      name: "Volta central brain"
    });
    expect(
      within(workspace).getByRole("heading", { name: "Volta", level: 1 })
    ).toBeInTheDocument();
    expect(
      within(workspace).getByRole("navigation", {
        name: "Volta conversations"
      })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Close Volta Copilot" })
    ).not.toBeInTheDocument();
    expect(await screen.findByText(operation.id)).toBeInTheDocument();
    expect(screen.queryByText("no operation loaded")).not.toBeInTheDocument();
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
      'event: activity\ndata: {"stage":"searching_records","label":"Searching operational records"}\n\n',
      `event: final\ndata: ${JSON.stringify(finalMessage)}\n\n`
    ].join("");
    const operation = { ...seedOperation(), pipelineStage: "open" };
    const fetchMock = vi
      .fn()
      .mockImplementation(async (input: string, init?: RequestInit) => {
        if (input === "/api/operation") {
          return { ok: true, json: async () => operation };
        }
        if (input === "/api/agent/conversations" && init?.method === "POST") {
          return {
            ok: true,
            json: async () => ({
              id: "conversation-001",
              organizationId: "textiles-pacifico",
              createdBy: "dispatcher",
              title: "Where is the shipment?",
              messages: [],
              createdAt: "2026-09-01T15:00:00.000Z",
              updatedAt: "2026-09-01T15:00:00.000Z"
            })
          };
        }
        if (input === "/api/agent/conversations") {
          return { ok: true, json: async () => [] };
        }
        if (input === "/api/agent/conversations/conversation-001/messages") {
          return new Response(stream, {
            status: 200,
            headers: { "content-type": "text/event-stream" }
          });
        }
        throw new Error(`Unexpected request: ${input}`);
      });
    vi.stubGlobal("fetch", fetchMock);
    render(<DashboardConsole />);

    openNavigationItem("Volta");
    fireEvent.change(
      await screen.findByLabelText("Ask across operational history"),
      {
        target: { value: "Where is the shipment?" }
      }
    );
    const workspace = screen.getByRole("region", {
      name: "Volta central brain"
    });
    await vi.waitFor(() =>
      expect(
        within(workspace).getByRole("button", { name: "Ask Volta" })
      ).toBeEnabled()
    );
    fireEvent.click(
      within(workspace).getByRole("button", { name: "Ask Volta" })
    );

    expect(
      await screen.findByText("The shipment is still at the origin terminal.")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Carga en origen" })
    ).toHaveAttribute("href", "/api/evidence/shipment_event/event-001");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/agent/conversations/conversation-001/messages",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("restores the latest conversation and renames it", async () => {
    const conversation = {
      id: "conversation-latest",
      organizationId: "textiles-pacifico",
      createdBy: "dispatcher",
      title: "Morning triage",
      messages: [],
      createdAt: "2026-09-01T14:00:00.000Z",
      updatedAt: "2026-09-01T15:00:00.000Z"
    };
    const detail = {
      ...conversation,
      messages: [
        {
          id: "assistant-latest",
          conversationId: conversation.id,
          role: "assistant",
          content: "Two approvals need your attention.",
          citations: [],
          proposedActions: [],
          createdAt: "2026-09-01T15:00:00.000Z"
        }
      ]
    };
    const operation = { ...seedOperation(), pipelineStage: "open" };
    const fetchMock = vi
      .fn()
      .mockImplementation(async (input: string, init?: RequestInit) => {
        if (input === "/api/operation") {
          return { ok: true, json: async () => operation };
        }
        if (input === "/api/agent/conversations") {
          return { ok: true, json: async () => [conversation] };
        }
        if (
          input === "/api/agent/conversations/conversation-latest" &&
          init?.method === "PATCH"
        ) {
          return {
            ok: true,
            json: async () => ({
              ...conversation,
              title: "Priority approvals"
            })
          };
        }
        if (input === "/api/agent/conversations/conversation-latest") {
          return { ok: true, json: async () => detail };
        }
        throw new Error(`Unexpected request: ${input}`);
      });
    vi.stubGlobal("fetch", fetchMock);
    render(<DashboardConsole />);

    openNavigationItem("Volta");
    expect(
      await screen.findByText("Two approvals need your attention.")
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Rename Morning triage" })
    );
    const titleInput = screen.getByLabelText("Conversation title");
    fireEvent.change(titleInput, { target: { value: "Priority approvals" } });
    fireEvent.submit(titleInput.closest("form")!);

    expect(
      (await screen.findAllByText("Priority approvals")).length
    ).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/agent/conversations/conversation-latest",
      expect.objectContaining({ method: "PATCH" })
    );
  });

  it("deletes a conversation only after confirmation", async () => {
    const conversation = {
      id: "conversation-delete",
      organizationId: "textiles-pacifico",
      createdBy: "dispatcher",
      title: "Discarded triage",
      messages: [],
      createdAt: "2026-09-01T14:00:00.000Z",
      updatedAt: "2026-09-01T15:00:00.000Z"
    };
    const operation = { ...seedOperation(), pipelineStage: "open" };
    const fetchMock = vi
      .fn()
      .mockImplementation(async (input: string, init?: RequestInit) => {
        if (input === "/api/operation") {
          return { ok: true, json: async () => operation };
        }
        if (input === "/api/agent/conversations") {
          return { ok: true, json: async () => [conversation] };
        }
        if (
          input === "/api/agent/conversations/conversation-delete" &&
          init?.method === "DELETE"
        ) {
          return { ok: true, status: 204 };
        }
        if (input === "/api/agent/conversations/conversation-delete") {
          return { ok: true, json: async () => conversation };
        }
        throw new Error(`Unexpected request: ${input}`);
      });
    vi.stubGlobal("fetch", fetchMock);
    render(<DashboardConsole />);

    openNavigationItem("Volta");
    expect(await screen.findByText("Discarded triage")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Delete Discarded triage" })
    );
    expect(
      screen.getByText("Delete this chat and its pending proposals?")
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/agent/conversations/conversation-delete",
      expect.objectContaining({ method: "DELETE" })
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete chat" }));

    await screen.findByText("What should we look at?");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/agent/conversations/conversation-delete",
      expect.objectContaining({ method: "DELETE" })
    );
    expect(screen.queryByText("Discarded triage")).not.toBeInTheDocument();
  });

  it("recovers conversation history after a transient read failure", async () => {
    const operation = { ...seedOperation(), pipelineStage: "open" };
    const conversation = {
      id: "conversation-recovered",
      organizationId: "textiles-pacifico",
      createdBy: "dispatcher",
      title: "Recovered history",
      messages: [],
      createdAt: "2026-09-01T14:00:00.000Z",
      updatedAt: "2026-09-01T15:00:00.000Z"
    };
    const detail = {
      ...conversation,
      messages: [
        {
          id: "assistant-recovered",
          conversationId: conversation.id,
          role: "assistant",
          content: "Operational memory is available again.",
          citations: [],
          proposedActions: [],
          createdAt: "2026-09-01T15:00:00.000Z"
        }
      ]
    };
    let listAttempts = 0;
    const fetchMock = vi.fn().mockImplementation(async (input: string) => {
      if (input === "/api/operation") {
        return { ok: true, json: async () => operation };
      }
      if (input === "/api/agent/conversations") {
        listAttempts += 1;
        if (listAttempts === 1) throw new Error("temporary_network_failure");
        return { ok: true, json: async () => [conversation] };
      }
      if (input === "/api/agent/conversations/conversation-recovered") {
        return { ok: true, json: async () => detail };
      }
      throw new Error(`Unexpected request: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<DashboardConsole />);

    openNavigationItem("Volta");

    expect(
      await screen.findByText("Operational memory is available again.")
    ).toBeInTheDocument();
    expect(listAttempts).toBe(2);
    expect(
      screen.queryByText(/could not load conversation history/i)
    ).not.toBeInTheDocument();
  });

  it("recovers the carrier directory after a transient read failure", async () => {
    let carrierAttempts = 0;
    const fetchMock = vi.fn().mockImplementation(async (input: string) => {
      if (input === "/api/carriers") {
        carrierAttempts += 1;
        if (carrierAttempts === 1) throw new Error("temporary_network_failure");
        return {
          ok: true,
          json: async () => [
            {
              id: "carrier-juan",
              name: "Juan Camilo",
              phone: "+573224118118",
              lanes: ["Manzanillo - Guadalajara"],
              active: true
            }
          ]
        };
      }
      throw new Error(`Unexpected request: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<DashboardConsole />);

    openNavigationItem("Carriers");

    expect(await screen.findByText("Juan Camilo")).toBeInTheDocument();
    expect(carrierAttempts).toBe(2);
    expect(
      screen.queryByText(/carrier directory is unavailable/i)
    ).not.toBeInTheDocument();
  });

  it("shows a safe actionable message for an agent SSE failure", async () => {
    const operation = { ...seedOperation(), pipelineStage: "open" };
    const stream = [
      'event: error\ndata: {"error":"agent_configuration_invalid","message":"private raw detail"}\n\n'
    ].join("");
    const fetchMock = vi
      .fn()
      .mockImplementation(async (input: string, init?: RequestInit) => {
        if (input === "/api/operation") {
          return { ok: true, json: async () => operation };
        }
        if (input === "/api/agent/conversations" && init?.method === "POST") {
          return {
            ok: true,
            json: async () => ({
              id: "conversation-error",
              organizationId: "textiles-pacifico",
              createdBy: "dispatcher",
              title: "Status",
              messages: [],
              createdAt: "2026-09-01T15:00:00.000Z",
              updatedAt: "2026-09-01T15:00:00.000Z"
            })
          };
        }
        if (input === "/api/agent/conversations") {
          return { ok: true, json: async () => [] };
        }
        if (input === "/api/agent/conversations/conversation-error/messages") {
          return new Response(stream, {
            status: 200,
            headers: { "content-type": "text/event-stream" }
          });
        }
        throw new Error(`Unexpected request: ${input}`);
      });
    vi.stubGlobal("fetch", fetchMock);
    render(<DashboardConsole />);

    openNavigationItem("Volta");
    fireEvent.change(
      await screen.findByLabelText("Ask across operational history"),
      { target: { value: "Status" } }
    );
    await vi.waitFor(() =>
      expect(screen.getByRole("button", { name: "Ask Volta" })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole("button", { name: "Ask Volta" }));

    expect(
      await screen.findByText(
        "Volta's operational tools are temporarily unavailable. No action was taken."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText("private raw detail")).not.toBeInTheDocument();
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
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload).toMatchObject({
      budget_cap: 9000,
      destination_place: "Textiles Pacífico, Guadalajara, Jalisco",
      type_of_content: "textiles",
      weight: 18400,
      measures: "120 × 100 × 110 cm",
      pickup_address: "Terminal de Contenedores, Manzanillo, Colima"
    });
    expect(payload.pickup_datetime).toMatch(/^2026-09-03T\d{2}:00:00\.000Z$/);
    expect(payload.destination_datetime).toMatch(
      /^2026-09-03T\d{2}:00:00\.000Z$/
    );
    expect(Date.parse(payload.pickup_datetime)).toBeLessThan(
      Date.parse(payload.destination_datetime)
    );
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
      "/api/approvals/approval-quote-round-001/decision?operationId=operation-textiles-pacifico-001",
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
      "/api/approvals/approval-quote-round-001/undo?operationId=operation-textiles-pacifico-001",
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
