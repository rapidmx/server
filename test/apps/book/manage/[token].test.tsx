// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import ManageBookingPage from "../../../../apps/book/manage/[token].js";

function booking(overrides: Record<string, unknown> = {}) {
    return {
        uid: "b1",
        bookingTypeSlug: "intro-call",
        name: "30 Minute Intro Call",
        hostDisplayName: "Jane Host",
        bookerName: "Bob",
        bookerEmail: "bob@example.com",
        startDate: "2026-09-10T13:00:00.000Z",
        endDate: "2026-09-10T13:30:00.000Z",
        status: "confirmed",
        ...overrides,
    };
}

const publicBookingType = { slug: "intro-call", name: "30 Minute Intro Call", hostDisplayName: "Jane Host", bookingWindowDays: 30 };

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

describe("ManageBookingPage", () => {
    it("shows the booking details once loaded", async () => {
        mockPage((url) => (url === "/api/mail/bookings/manage/tok123" ? jsonResponse(200, booking()) : undefined));
        render(<ManageBookingPage params={{ token: "tok123" }} />);

        expect(await screen.findByRole("heading", { name: "30 Minute Intro Call" })).toBeInTheDocument();
        expect(screen.getByText("with Jane Host")).toBeInTheDocument();
    });

    it("shows a pending note for a booking awaiting approval", async () => {
        mockPage((url) => (url === "/api/mail/bookings/manage/tok123" ? jsonResponse(200, booking({ status: "pending" })) : undefined));
        render(<ManageBookingPage params={{ token: "tok123" }} />);
        expect(await screen.findByText("Awaiting the host’s confirmation.")).toBeInTheDocument();
    });

    it("shows a cancelled state with no actions", async () => {
        mockPage((url) => (url === "/api/mail/bookings/manage/tok123" ? jsonResponse(200, booking({ status: "cancelled" })) : undefined));
        render(<ManageBookingPage params={{ token: "tok123" }} />);

        expect(await screen.findByText("This booking has been cancelled.")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Reschedule" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Cancel booking" })).not.toBeInTheDocument();
    });

    it("falls back to 'Booking not found.' when the load succeeds with no booking and no error", async () => {
        mockPage((url) => (url === "/api/mail/bookings/manage/tok123" ? jsonResponse(200, null) : undefined));
        render(<ManageBookingPage params={{ token: "tok123" }} />);
        expect(await screen.findByText("Booking not found.")).toBeInTheDocument();
    });

    it("shows an error when loading fails", async () => {
        mockPage((url) => (url === "/api/mail/bookings/manage/tok123" ? jsonResponse(404, { message: "not found" }) : undefined));
        render(<ManageBookingPage params={{ token: "tok123" }} />);
        expect(await screen.findByText("not found")).toBeInTheDocument();
    });

    it("shows a generic error message when loading fails with a non-API error", async () => {
        mockPage((url) => {
            if (url === "/api/mail/bookings/manage/tok123") throw new TypeError("network down");
            return undefined;
        });
        render(<ManageBookingPage params={{ token: "tok123" }} />);
        expect(await screen.findByText("Could not load this booking.")).toBeInTheDocument();
    });

    it("cancels the booking via the confirmation modal", async () => {
        const fetchMock = mockPage((url, init) => {
            if (url === "/api/mail/bookings/manage/tok123" && (init?.method ?? "GET") === "GET") return jsonResponse(200, booking());
            if (url === "/api/mail/bookings/manage/tok123/cancel" && init?.method === "POST") {
                return jsonResponse(200, booking({ status: "cancelled" }));
            }
            return undefined;
        });
        const user = userEvent.setup();
        render(<ManageBookingPage params={{ token: "tok123" }} />);
        await screen.findByRole("heading", { name: "30 Minute Intro Call" });

        await user.click(screen.getByRole("button", { name: "Cancel booking" }));
        const dialog = screen.getByRole("dialog", { name: "Cancel booking" });
        await user.click(within(dialog).getByRole("button", { name: "Cancel booking" }));

        expect(await screen.findByText("This booking has been cancelled.")).toBeInTheDocument();
        expect(fetchMock.mock.calls.some(([url, init]: any) => url === "/api/mail/bookings/manage/tok123/cancel" && init?.method === "POST")).toBe(
            true,
        );
    });

    it("also closes the cancel modal via its own Close button (Modal's onClose, distinct from Never mind)", async () => {
        mockPage((url) => (url === "/api/mail/bookings/manage/tok123" ? jsonResponse(200, booking()) : undefined));
        const user = userEvent.setup();
        render(<ManageBookingPage params={{ token: "tok123" }} />);
        await screen.findByRole("heading", { name: "30 Minute Intro Call" });

        await user.click(screen.getByRole("button", { name: "Cancel booking" }));
        await user.click(screen.getByRole("button", { name: "Close" }));

        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("closes the cancel modal via Never mind, without canceling", async () => {
        const fetchMock = mockPage((url) => (url === "/api/mail/bookings/manage/tok123" ? jsonResponse(200, booking()) : undefined));
        const user = userEvent.setup();
        render(<ManageBookingPage params={{ token: "tok123" }} />);
        await screen.findByRole("heading", { name: "30 Minute Intro Call" });

        await user.click(screen.getByRole("button", { name: "Cancel booking" }));
        await user.click(screen.getByRole("button", { name: "Never mind" }));

        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(fetchMock.mock.calls.some(([, init]: any) => init?.method === "POST")).toBe(false);
    });

    it("shows an error message when cancellation fails", async () => {
        mockPage((url, init) => {
            if (url === "/api/mail/bookings/manage/tok123" && (init?.method ?? "GET") === "GET") return jsonResponse(200, booking());
            if (url === "/api/mail/bookings/manage/tok123/cancel" && init?.method === "POST") return jsonResponse(500, { message: "boom" });
            return undefined;
        });
        const user = userEvent.setup();
        render(<ManageBookingPage params={{ token: "tok123" }} />);
        await screen.findByRole("heading", { name: "30 Minute Intro Call" });

        await user.click(screen.getByRole("button", { name: "Cancel booking" }));
        await user.click(screen.getAllByRole("button", { name: "Cancel booking" })[1]);

        expect(await screen.findByText("boom")).toBeInTheDocument();
    });

    it("shows a generic error message when cancellation fails with a non-API error", async () => {
        mockPage((url, init) => {
            if (url === "/api/mail/bookings/manage/tok123" && (init?.method ?? "GET") === "GET") return jsonResponse(200, booking());
            if (url === "/api/mail/bookings/manage/tok123/cancel" && init?.method === "POST") throw new TypeError("network down");
            return undefined;
        });
        const user = userEvent.setup();
        render(<ManageBookingPage params={{ token: "tok123" }} />);
        await screen.findByRole("heading", { name: "30 Minute Intro Call" });

        await user.click(screen.getByRole("button", { name: "Cancel booking" }));
        await user.click(screen.getAllByRole("button", { name: "Cancel booking" })[1]);

        expect(await screen.findByText("Could not cancel this booking.")).toBeInTheDocument();
    });

    it("reschedules the booking to a newly chosen slot", async () => {
        const newSlot = { start: "2026-09-11T15:00:00.000Z", end: "2026-09-11T15:30:00.000Z" };
        const fetchMock = mockPage((url, init) => {
            if (url === "/api/mail/bookings/manage/tok123" && (init?.method ?? "GET") === "GET") return jsonResponse(200, booking());
            if (url === "/api/mail/bookings/types/intro-call") return jsonResponse(200, publicBookingType);
            if (url.startsWith("/api/mail/bookings/types/intro-call/slots?")) return jsonResponse(200, [newSlot]);
            if (url === "/api/mail/bookings/manage/tok123/reschedule" && init?.method === "POST") {
                return jsonResponse(200, booking({ startDate: newSlot.start, endDate: newSlot.end }));
            }
            return undefined;
        });
        const user = userEvent.setup();
        render(<ManageBookingPage params={{ token: "tok123" }} />);
        await screen.findByRole("heading", { name: "30 Minute Intro Call" });

        await user.click(screen.getByRole("button", { name: "Reschedule" }));
        const slotLabel = new Date(newSlot.start).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
        await user.click(await screen.findByRole("button", { name: slotLabel }));

        await vi.waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/mail/bookings/manage/tok123/reschedule",
                expect.objectContaining({ method: "POST", body: JSON.stringify({ start: newSlot.start }) }),
            ),
        );
        expect(await screen.findByRole("button", { name: "Reschedule" })).toBeInTheDocument();
    });

    it("offers later reschedule times across the booking type's whole window", async () => {
        const first = { start: "2026-09-11T15:00:00.000Z", end: "2026-09-11T15:30:00.000Z" };
        const later = { start: "2026-11-20T15:00:00.000Z", end: "2026-11-20T15:30:00.000Z" };
        const requested: URLSearchParams[] = [];
        mockPage((url) => {
            if (url === "/api/mail/bookings/manage/tok123") return jsonResponse(200, booking());
            if (url === "/api/mail/bookings/types/intro-call") return jsonResponse(200, { ...publicBookingType, bookingWindowDays: 90 });
            if (url.startsWith("/api/mail/bookings/types/intro-call/slots?")) {
                requested.push(new URL(url, "http://localhost").searchParams);
                return jsonResponse(200, requested.length === 1 ? [first] : requested.length === 2 ? [] : [later]);
            }
            return undefined;
        });
        const user = userEvent.setup();
        render(<ManageBookingPage params={{ token: "tok123" }} />);
        await screen.findByRole("heading", { name: "30 Minute Intro Call" });

        await user.click(screen.getByRole("button", { name: "Reschedule" }));
        await user.click(await screen.findByRole("button", { name: "Show later times" }));

        // The empty second window is skipped over rather than ending the list.
        const label = (slot: { start: string }) =>
            new Date(slot.start).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
        expect(await screen.findByRole("button", { name: label(later) })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: label(first) })).toBeInTheDocument();
        expect(requested).toHaveLength(3);
        expect(requested[2].get("from")).toBe(requested[1].get("to"));
        expect(screen.queryByRole("button", { name: "Show later times" })).not.toBeInTheDocument();
    });

    describe("Show later times", () => {
        const first = { start: "2026-09-11T15:00:00.000Z", end: "2026-09-11T15:30:00.000Z" };
        const label = (slot: { start: string }) =>
            new Date(slot.start).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

        /** A 90-day booking type whose first slots window has `first`, and whose later windows answer `later()`. */
        function mockLaterSlots(later: (call: number) => Response) {
            let calls = 0;
            mockPage((url) => {
                if (url === "/api/mail/bookings/manage/tok123") return jsonResponse(200, booking());
                if (url === "/api/mail/bookings/types/intro-call") return jsonResponse(200, { ...publicBookingType, bookingWindowDays: 90 });
                if (url.startsWith("/api/mail/bookings/types/intro-call/slots?")) {
                    calls++;
                    return calls === 1 ? jsonResponse(200, [first]) : later(calls);
                }
                return undefined;
            });
            return () => calls;
        }

        async function openPickerAndShowLater() {
            const user = userEvent.setup();
            render(<ManageBookingPage params={{ token: "tok123" }} />);
            await screen.findByRole("heading", { name: "30 Minute Intro Call" });
            await user.click(screen.getByRole("button", { name: "Reschedule" }));
            await user.click(await screen.findByRole("button", { name: "Show later times" }));
        }

        it("shows the API's error when loading later times fails, keeping the times already offered", async () => {
            mockLaterSlots(() => jsonResponse(503, { message: "try again soon" }));
            await openPickerAndShowLater();

            expect(await screen.findByText("try again soon")).toBeInTheDocument();
            expect(screen.getByRole("button", { name: label(first) })).toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Show later times" })).toBeEnabled();
        });

        it("shows a generic error when loading later times fails with a non-API error", async () => {
            mockLaterSlots(() => {
                throw new TypeError("network down");
            });
            await openPickerAndShowLater();

            expect(await screen.findByText("Could not load more times.")).toBeInTheDocument();
            expect(screen.getByRole("button", { name: label(first) })).toBeInTheDocument();
        });

        it("clears a previous error and removes the button once the rest of the window is fully booked", async () => {
            const calls = mockLaterSlots((call) => (call === 2 ? jsonResponse(503, { message: "try again soon" }) : jsonResponse(200, [])));
            await openPickerAndShowLater();
            await screen.findByText("try again soon");

            await userEvent.setup().click(screen.getByRole("button", { name: "Show later times" }));

            await vi.waitFor(() => expect(screen.queryByRole("button", { name: "Show later times" })).not.toBeInTheDocument());
            expect(screen.queryByText("try again soon")).not.toBeInTheDocument();
            // Retried from the same cursor: windows 2 and 3 of the 90-day window, both empty.
            expect(calls()).toBe(4);
            expect(screen.getByRole("button", { name: label(first) })).toBeInTheDocument();
            expect(screen.queryByText("No open slots right now.")).not.toBeInTheDocument();
        });
    });

    it("stops after two fully booked windows when rescheduling starts, and offers later times", async () => {
        const later = { start: "2026-12-01T15:00:00.000Z", end: "2026-12-01T15:30:00.000Z" };
        const requested: URLSearchParams[] = [];
        mockPage((url) => {
            if (url === "/api/mail/bookings/manage/tok123") return jsonResponse(200, booking());
            if (url === "/api/mail/bookings/types/intro-call") return jsonResponse(200, { ...publicBookingType, bookingWindowDays: 365 });
            if (url.startsWith("/api/mail/bookings/types/intro-call/slots?")) {
                requested.push(new URL(url, "http://localhost").searchParams);
                return jsonResponse(200, requested.length === 3 ? [later] : []);
            }
            return undefined;
        });
        const user = userEvent.setup();
        render(<ManageBookingPage params={{ token: "tok123" }} />);
        await screen.findByRole("heading", { name: "30 Minute Intro Call" });

        await user.click(screen.getByRole("button", { name: "Reschedule" }));
        expect(await screen.findByText("No open times in the next few weeks.")).toBeInTheDocument();
        expect(requested).toHaveLength(2);

        await user.click(screen.getByRole("button", { name: "Show later times" }));
        const label = new Date(later.start).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
        expect(await screen.findByRole("button", { name: label })).toBeInTheDocument();
        expect(requested).toHaveLength(3);
    });

    it("shows an empty state when there are no slots to reschedule into", async () => {
        mockPage((url) => {
            if (url === "/api/mail/bookings/manage/tok123") return jsonResponse(200, booking());
            if (url === "/api/mail/bookings/types/intro-call") return jsonResponse(200, publicBookingType);
            if (url.startsWith("/api/mail/bookings/types/intro-call/slots?")) return jsonResponse(200, []);
            return undefined;
        });
        const user = userEvent.setup();
        render(<ManageBookingPage params={{ token: "tok123" }} />);
        await screen.findByRole("heading", { name: "30 Minute Intro Call" });

        await user.click(screen.getByRole("button", { name: "Reschedule" }));

        expect(await screen.findByText("No open slots right now.")).toBeInTheDocument();
    });

    it("shows an error message when loading reschedule slots fails", async () => {
        mockPage((url) => {
            if (url === "/api/mail/bookings/manage/tok123") return jsonResponse(200, booking());
            if (url === "/api/mail/bookings/types/intro-call") return jsonResponse(200, publicBookingType);
            if (url.startsWith("/api/mail/bookings/types/intro-call/slots?")) return jsonResponse(500, { message: "boom" });
            return undefined;
        });
        const user = userEvent.setup();
        render(<ManageBookingPage params={{ token: "tok123" }} />);
        await screen.findByRole("heading", { name: "30 Minute Intro Call" });

        await user.click(screen.getByRole("button", { name: "Reschedule" }));

        expect(await screen.findByText("boom")).toBeInTheDocument();
    });

    it("shows a generic error message when loading reschedule slots fails with a non-API error", async () => {
        mockPage((url) => {
            if (url === "/api/mail/bookings/manage/tok123") return jsonResponse(200, booking());
            if (url === "/api/mail/bookings/types/intro-call") return jsonResponse(200, publicBookingType);
            if (url.startsWith("/api/mail/bookings/types/intro-call/slots?")) throw new TypeError("network down");
            return undefined;
        });
        const user = userEvent.setup();
        render(<ManageBookingPage params={{ token: "tok123" }} />);
        await screen.findByRole("heading", { name: "30 Minute Intro Call" });

        await user.click(screen.getByRole("button", { name: "Reschedule" }));

        expect(await screen.findByText("Could not load new times.")).toBeInTheDocument();
    });

    it("cancels out of the reschedule picker via Never mind", async () => {
        mockPage((url) => {
            if (url === "/api/mail/bookings/manage/tok123") return jsonResponse(200, booking());
            if (url === "/api/mail/bookings/types/intro-call") return jsonResponse(200, publicBookingType);
            if (url.startsWith("/api/mail/bookings/types/intro-call/slots?")) return jsonResponse(200, []);
            return undefined;
        });
        const user = userEvent.setup();
        render(<ManageBookingPage params={{ token: "tok123" }} />);
        await screen.findByRole("heading", { name: "30 Minute Intro Call" });

        await user.click(screen.getByRole("button", { name: "Reschedule" }));
        await screen.findByText("No open slots right now.");
        await user.click(screen.getByRole("button", { name: "Never mind" }));

        expect(screen.getByRole("button", { name: "Reschedule" })).toBeInTheDocument();
    });

    it("shows an error message when rescheduling fails", async () => {
        const newSlot = { start: "2026-09-11T15:00:00.000Z", end: "2026-09-11T15:30:00.000Z" };
        mockPage((url, init) => {
            if (url === "/api/mail/bookings/manage/tok123" && (init?.method ?? "GET") === "GET") return jsonResponse(200, booking());
            if (url === "/api/mail/bookings/types/intro-call") return jsonResponse(200, publicBookingType);
            if (url.startsWith("/api/mail/bookings/types/intro-call/slots?")) return jsonResponse(200, [newSlot]);
            if (url === "/api/mail/bookings/manage/tok123/reschedule" && init?.method === "POST") return jsonResponse(409, { message: "no longer available" });
            return undefined;
        });
        const user = userEvent.setup();
        render(<ManageBookingPage params={{ token: "tok123" }} />);
        await screen.findByRole("heading", { name: "30 Minute Intro Call" });

        await user.click(screen.getByRole("button", { name: "Reschedule" }));
        const slotLabel = new Date(newSlot.start).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
        await user.click(await screen.findByRole("button", { name: slotLabel }));

        expect(await screen.findByText("no longer available")).toBeInTheDocument();
    });

    it("shows a generic error message when rescheduling fails with a non-API error", async () => {
        const newSlot = { start: "2026-09-11T15:00:00.000Z", end: "2026-09-11T15:30:00.000Z" };
        mockPage((url, init) => {
            if (url === "/api/mail/bookings/manage/tok123" && (init?.method ?? "GET") === "GET") return jsonResponse(200, booking());
            if (url === "/api/mail/bookings/types/intro-call") return jsonResponse(200, publicBookingType);
            if (url.startsWith("/api/mail/bookings/types/intro-call/slots?")) return jsonResponse(200, [newSlot]);
            if (url === "/api/mail/bookings/manage/tok123/reschedule" && init?.method === "POST") throw new TypeError("network down");
            return undefined;
        });
        const user = userEvent.setup();
        render(<ManageBookingPage params={{ token: "tok123" }} />);
        await screen.findByRole("heading", { name: "30 Minute Intro Call" });

        await user.click(screen.getByRole("button", { name: "Reschedule" }));
        const slotLabel = new Date(newSlot.start).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
        await user.click(await screen.findByRole("button", { name: slotLabel }));

        expect(await screen.findByText("Could not reschedule this booking.")).toBeInTheDocument();
    });
});
