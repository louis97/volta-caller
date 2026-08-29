import "@testing-library/jest-dom/vitest";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { DashboardConsole } from "./dashboard-console";

afterEach(cleanup);

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

  it("creates a mandate and returns to operations", () => {
    const { container } = render(<DashboardConsole />);

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

    expect(screen.getByText("Mandate VLT-2042 created")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open operation" }));
    expect(
      screen.getByRole("heading", { name: "Operations", level: 1 })
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
