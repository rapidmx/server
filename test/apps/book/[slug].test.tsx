// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import PublicBookingPage from "../../../apps/book/[slug].js";

const publicBookingType = {
    slug: "intro-call",
    name: "30 Minute Intro Call",
    description: "Let's chat",
    hostDisplayName: "Jane Host",
    durationMinutes: 30,
    timezone: "America/New_York",
    requiresApproval: false,
    minimumNoticeMinutes: 60,
    bookingWindowDays: 30,
};

const slot1 = { start: "2026-09-10T13:00:00.000Z", end: "2026-09-10T13:30:00.000Z" };
const slot2 = { start: "2026-09-10T14:00:00.000Z", end: "2026-09-10T14:30:00.000Z" };

function mockPage(extra?: (url: string, init?: RequestInit) => Response | undefined) {
    return mockFetch((url, init) => {
        const custom = extra?.(url, init);
        if (custom) return custom;
        if (url === "/api/system/branding") return jsonResponse(200, { companyName: "", title: "" });
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("PublicBookingPage", () => {
    it("pages through the whole booking window with Show later times", async () => {
        const later = { start: "2026-11-02T15:00:00.000Z", end: "2026-11-02T15:30:00.000Z" };
        const requested: URLSearchParams[] = [];
        mockPage((url) => {
            if (url === "/api/mail/bookings/types/intro-call") return jsonResponse(200, { ...publicBookingType, bookingWindowDays: 45 });
            if (url.startsWith("/api/mail/bookings/types/intro-call/slots?")) {
                requested.push(new URL(url, "http://localhost").searchParams);
                return jsonResponse(200, requested.length === 1 ? [slot1] : [later]);
            }
            return undefined;
        });
        const user = userEvent.setup();
        render(<PublicBookingPage params={{ slug: "intro-call" }} />);

        await user.click(await screen.findByRole("button", { name: "Show later times" }));
        const laterLabel = new Date(later.start).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
        expect(await screen.findByRole("button", { name: laterLabel })).toBeInTheDocument();
        // The second window starts where the first ended, and the 45-day window is then exhausted.
        expect(requested).toHaveLength(2);
        expect(requested[1].get("from")).toBe(requested[0].get("to"));
        expect(screen.queryByRole("button", { name: "Show later times" })).not.toBeInTheDocument();
    });

    it("shows an error when loading later times fails, keeping the slots already shown", async () => {
        let calls = 0;
        mockPage((url) => {
            if (url === "/api/mail/bookings/types/intro-call") return jsonResponse(200, { ...publicBookingType, bookingWindowDays: 90 });
            if (url.startsWith("/api/mail/bookings/types/intro-call/slots?")) {
                calls++;
                return calls === 1 ? jsonResponse(200, [slot1]) : jsonResponse(429, { message: "slow down" });
            }
            return undefined;
        });
        const user = userEvent.setup();
        render(<PublicBookingPage params={{ slug: "intro-call" }} />);

        await user.click(await screen.findByRole("button", { name: "Show later times" }));
        expect(await screen.findByText("slow down")).toBeInTheDocument();
        const slotLabel = new Date(slot1.start).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
        expect(screen.getByRole("button", { name: slotLabel })).toBeInTheDocument();
    });

    it("shows the offering details and grouped slots once loaded", async () => {
        mockPage((url) => {
            if (url === "/api/mail/bookings/types/intro-call") return jsonResponse(200, publicBookingType);
            if (url.startsWith("/api/mail/bookings/types/intro-call/slots?")) return jsonResponse(200, [slot1, slot2]);
            return undefined;
        });
        render(<PublicBookingPage params={{ slug: "intro-call" }} />);

        expect(await screen.findByText("30 Minute Intro Call")).toBeInTheDocument();
        expect(screen.getByText("with Jane Host")).toBeInTheDocument();
        expect(screen.getByText("Let's chat")).toBeInTheDocument();
        expect(screen.getByText("30 minutes")).toBeInTheDocument();
    });

    it("shows an error when the booking type fails to load", async () => {
        mockPage((url) => {
            if (url === "/api/mail/bookings/types/intro-call") return jsonResponse(404, { message: "not found" });
            if (url.startsWith("/api/mail/bookings/types/intro-call/slots?")) return jsonResponse(200, []);
            return undefined;
        });
        render(<PublicBookingPage params={{ slug: "intro-call" }} />);
        expect(await screen.findByText("not found")).toBeInTheDocument();
    });

    it("shows a generic error message when loading fails with a non-API error", async () => {
        mockPage((url) => {
            if (url === "/api/mail/bookings/types/intro-call") throw new TypeError("network down");
            if (url.startsWith("/api/mail/bookings/types/intro-call/slots?")) return jsonResponse(200, []);
            return undefined;
        });
        render(<PublicBookingPage params={{ slug: "intro-call" }} />);
        expect(await screen.findByText("Could not load this booking page.")).toBeInTheDocument();
    });

    it("falls back to a generic unavailable message when the load succeeds with no booking type and no error", async () => {
        mockPage((url) => {
            if (url === "/api/mail/bookings/types/intro-call") return jsonResponse(200, null);
            if (url.startsWith("/api/mail/bookings/types/intro-call/slots?")) return jsonResponse(200, []);
            return undefined;
        });
        render(<PublicBookingPage params={{ slug: "intro-call" }} />);
        expect(await screen.findByText("This booking link is not available.")).toBeInTheDocument();
    });

    it("shows an empty state when there are no open slots", async () => {
        mockPage((url) => {
            if (url === "/api/mail/bookings/types/intro-call") return jsonResponse(200, publicBookingType);
            if (url.startsWith("/api/mail/bookings/types/intro-call/slots?")) return jsonResponse(200, []);
            return undefined;
        });
        render(<PublicBookingPage params={{ slug: "intro-call" }} />);
        expect(await screen.findByText("No open slots right now — please check back later.")).toBeInTheDocument();
    });

    it("selects a slot, submits the booking form, and shows a confirmation with the manage link", async () => {
        mockPage((url, init) => {
            if (url === "/api/mail/bookings/types/intro-call" && (init?.method ?? "GET") === "GET") return jsonResponse(200, publicBookingType);
            if (url.startsWith("/api/mail/bookings/types/intro-call/slots?")) return jsonResponse(200, [slot1]);
            if (url === "/api/mail/bookings/types/intro-call" && init?.method === "POST") {
                return jsonResponse(200, {
                    uid: "b1",
                    bookingTypeSlug: "intro-call",
                    name: "30 Minute Intro Call",
                    hostDisplayName: "Jane Host",
                    bookerName: "Bob",
                    bookerEmail: "bob@example.com",
                    startDate: slot1.start,
                    endDate: slot1.end,
                    status: "confirmed",
                    manageToken: "tok123",
                });
            }
            return undefined;
        });
        const user = userEvent.setup();
        render(<PublicBookingPage params={{ slug: "intro-call" }} />);
        await screen.findByText("30 Minute Intro Call");

        await user.click(screen.getByRole("button", { name: new Date(slot1.start).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) }));
        await user.type(screen.getByLabelText("Your name"), "Bob");
        await user.type(screen.getByLabelText("Your email"), "bob@example.com");
        await user.type(screen.getByLabelText("Notes (optional)"), "Looking forward to it");
        await user.click(screen.getByRole("button", { name: "Confirm booking" }));

        expect(await screen.findByText("You’re booked!")).toBeInTheDocument();
        expect(screen.getByText(/Save this link to cancel or reschedule later/)).toBeInTheDocument();
        expect(screen.getByRole("link", { name: /book\/manage\/tok123/ })).toBeInTheDocument();
    });

    it("requires a name and email before submitting", async () => {
        mockPage((url) => {
            if (url === "/api/mail/bookings/types/intro-call") return jsonResponse(200, publicBookingType);
            if (url.startsWith("/api/mail/bookings/types/intro-call/slots?")) return jsonResponse(200, [slot1]);
            return undefined;
        });
        const user = userEvent.setup();
        render(<PublicBookingPage params={{ slug: "intro-call" }} />);
        await screen.findByText("30 Minute Intro Call");

        await user.click(
            screen.getByRole("button", { name: new Date(slot1.start).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) }),
        );
        await user.click(screen.getByRole("button", { name: "Confirm booking" }));

        expect(await screen.findByText("Your name and email are both required.")).toBeInTheDocument();
    });

    it("lets the visitor choose a different time before booking", async () => {
        mockPage((url) => {
            if (url === "/api/mail/bookings/types/intro-call") return jsonResponse(200, publicBookingType);
            if (url.startsWith("/api/mail/bookings/types/intro-call/slots?")) return jsonResponse(200, [slot1]);
            return undefined;
        });
        const user = userEvent.setup();
        render(<PublicBookingPage params={{ slug: "intro-call" }} />);
        await screen.findByText("30 Minute Intro Call");

        const timeLabel = new Date(slot1.start).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
        await user.click(screen.getByRole("button", { name: timeLabel }));
        await user.click(screen.getByRole("button", { name: "Choose a different time" }));

        expect(screen.getByRole("button", { name: timeLabel })).toBeInTheDocument();
    });

    it("shows an error message when booking fails", async () => {
        mockPage((url, init) => {
            if (url === "/api/mail/bookings/types/intro-call" && (init?.method ?? "GET") === "GET") return jsonResponse(200, publicBookingType);
            if (url.startsWith("/api/mail/bookings/types/intro-call/slots?")) return jsonResponse(200, [slot1]);
            if (url === "/api/mail/bookings/types/intro-call" && init?.method === "POST") return jsonResponse(409, { message: "slot taken" });
            return undefined;
        });
        const user = userEvent.setup();
        render(<PublicBookingPage params={{ slug: "intro-call" }} />);
        await screen.findByText("30 Minute Intro Call");

        await user.click(
            screen.getByRole("button", { name: new Date(slot1.start).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) }),
        );
        await user.type(screen.getByLabelText("Your name"), "Bob");
        await user.type(screen.getByLabelText("Your email"), "bob@example.com");
        await user.click(screen.getByRole("button", { name: "Confirm booking" }));

        expect(await screen.findByText("slot taken")).toBeInTheDocument();
    });

    it("shows a generic error message when booking fails with a non-API error", async () => {
        mockPage((url, init) => {
            if (url === "/api/mail/bookings/types/intro-call" && (init?.method ?? "GET") === "GET") return jsonResponse(200, publicBookingType);
            if (url.startsWith("/api/mail/bookings/types/intro-call/slots?")) return jsonResponse(200, [slot1]);
            if (url === "/api/mail/bookings/types/intro-call" && init?.method === "POST") throw new TypeError("network down");
            return undefined;
        });
        const user = userEvent.setup();
        render(<PublicBookingPage params={{ slug: "intro-call" }} />);
        await screen.findByText("30 Minute Intro Call");

        await user.click(
            screen.getByRole("button", { name: new Date(slot1.start).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) }),
        );
        await user.type(screen.getByLabelText("Your name"), "Bob");
        await user.type(screen.getByLabelText("Your email"), "bob@example.com");
        await user.click(screen.getByRole("button", { name: "Confirm booking" }));

        expect(await screen.findByText("Could not book this slot.")).toBeInTheDocument();
    });

    it("shows a confirmation with no manage link when the response carries no manageToken", async () => {
        mockPage((url, init) => {
            if (url === "/api/mail/bookings/types/intro-call" && (init?.method ?? "GET") === "GET") return jsonResponse(200, publicBookingType);
            if (url.startsWith("/api/mail/bookings/types/intro-call/slots?")) return jsonResponse(200, [slot1]);
            if (url === "/api/mail/bookings/types/intro-call" && init?.method === "POST") {
                return jsonResponse(200, {
                    uid: "b1",
                    bookingTypeSlug: "intro-call",
                    name: "30 Minute Intro Call",
                    hostDisplayName: "Jane Host",
                    bookerName: "Bob",
                    bookerEmail: "bob@example.com",
                    startDate: slot1.start,
                    endDate: slot1.end,
                    status: "confirmed",
                });
            }
            return undefined;
        });
        const user = userEvent.setup();
        render(<PublicBookingPage params={{ slug: "intro-call" }} />);
        await screen.findByText("30 Minute Intro Call");

        await user.click(
            screen.getByRole("button", { name: new Date(slot1.start).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) }),
        );
        await user.type(screen.getByLabelText("Your name"), "Bob");
        await user.type(screen.getByLabelText("Your email"), "bob@example.com");
        await user.click(screen.getByRole("button", { name: "Confirm booking" }));

        expect(await screen.findByText("You’re booked!")).toBeInTheDocument();
        expect(screen.queryByText(/Save this link/)).not.toBeInTheDocument();
    });
});
