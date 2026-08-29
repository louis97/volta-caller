import "@testing-library/jest-dom/vitest";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  it("navigates between the four dispatch views", () => {
    render(<DashboardConsole />);

    expect(
      screen.getByRole("heading", { name: "Operations", level: 1 })
    ).toBeInTheDocument();

    openNavigationItem("Call floor");
    expect(
      screen.getByRole("heading", { name: "Call floor", level: 1 })
    ).toBeInTheDocument();

    openNavigationItem("Approvals");
    expect(
      screen.getByRole("heading", { name: "Approvals", level: 1 })
    ).toBeInTheDocument();
  });

  it("posts the complete mandate to the API before showing it as created", async () => {
    const { container } = render(<DashboardConsole />);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "operation-mandate-1" })
    });
    vi.stubGlobal("fetch", fetchMock);

    openNavigationItem("New mandate");

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
    fireEvent.click(screen.getByRole("button", { name: "Open operation" }));
    expect(
      screen.getByRole("heading", { name: "Operations", level: 1 })
    ).toBeInTheDocument();
  });

  it("keeps the mandate unsaved when the API rejects it", async () => {
    render(<DashboardConsole />);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) })
    );

    openNavigationItem("New mandate");
    fireEvent.click(screen.getByRole("button", { name: "Launch mandate" }));

    expect(
      await screen.findByText(/Volta could not save this mandate/)
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Launch mandate" })
    ).toBeInTheDocument();
  });

  it("records a human approval decision", () => {
    render(<DashboardConsole />);

    openNavigationItem("Approvals");
    fireEvent.click(screen.getByRole("button", { name: "Approve exception" }));

    expect(screen.getByText("Pickup exception approved")).toBeInTheDocument();
    expect(screen.getByText(/a human made this decision/)).toBeInTheDocument();
  });
});
