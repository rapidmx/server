///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import {
    MAX_REQUESTS_PER_PAGE,
    MAX_SLOTS_PER_RESPONSE,
    SLOT_CHUNK_DAYS,
    appendSlots,
    fetchSlotPage,
    initialSlotCursor,
} from "../../../apps/book/_slotPaging.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 14, 12, 0, 0);

function slotAt(ms: number) {
    return { start: new Date(ms).toISOString(), end: new Date(ms + 30 * 60 * 1000).toISOString() };
}

/** Stubs the slots endpoint with one response per call, recording each call's from/to. */
function mockSlots(responses: unknown[][]) {
    const requested: { from: number; to: number }[] = [];
    mockFetch((url) => {
        const params = new URL(url, "http://localhost").searchParams;
        requested.push({ from: Date.parse(params.get("from")!), to: Date.parse(params.get("to")!) });
        return jsonResponse(200, responses[requested.length - 1] ?? []);
    });
    return requested;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("_slotPaging", () => {
    it("initialSlotCursor() spans bookingWindowDays, defaulting to one chunk", () => {
        expect(initialSlotCursor(90, NOW)).toEqual({ from: NOW, horizon: NOW + 90 * DAY });
        expect(initialSlotCursor(undefined, NOW)).toEqual({ from: NOW, horizon: NOW + SLOT_CHUNK_DAYS * DAY });
        expect(initialSlotCursor(0, NOW)).toEqual({ from: NOW, horizon: NOW + SLOT_CHUNK_DAYS * DAY });
    });

    it("asks for one chunk, and continues from its end while the window lasts", async () => {
        const requested = mockSlots([[slotAt(NOW + DAY)]]);
        const page = await fetchSlotPage("intro-call", initialSlotCursor(90, NOW));

        expect(requested).toEqual([{ from: NOW, to: NOW + SLOT_CHUNK_DAYS * DAY }]);
        expect(page.slots).toHaveLength(1);
        expect(page.next).toEqual({ from: NOW + SLOT_CHUNK_DAYS * DAY, horizon: NOW + 90 * DAY });
    });

    it("ends once a chunk reaches the horizon", async () => {
        mockSlots([[slotAt(NOW + DAY)]]);
        const page = await fetchSlotPage("intro-call", initialSlotCursor(30, NOW));
        expect(page.next).toBeNull();
    });

    it("skips a fully booked chunk until it finds a slot", async () => {
        const later = slotAt(NOW + 35 * DAY);
        const requested = mockSlots([[], [later]]);
        const page = await fetchSlotPage("intro-call", initialSlotCursor(120, NOW));

        expect(requested.map((r) => r.from)).toEqual([NOW, NOW + 30 * DAY]);
        expect(page.slots).toEqual([later]);
        expect(page.next).toEqual({ from: NOW + 60 * DAY, horizon: NOW + 120 * DAY });
    });

    it("stops after MAX_REQUESTS_PER_PAGE empty chunks, returning an empty page that can continue", async () => {
        // The anonymous slots endpoint shares a per-IP rate limit, so a long fully booked window isn't walked in one go.
        expect(MAX_REQUESTS_PER_PAGE).toBe(2);
        const later = slotAt(NOW + 65 * DAY);
        const requested = mockSlots([[], [], [later]]);

        const first = await fetchSlotPage("intro-call", initialSlotCursor(365, NOW));
        expect(requested).toHaveLength(2);
        expect(first).toEqual({ slots: [], next: { from: NOW + 60 * DAY, horizon: NOW + 365 * DAY } });

        const second = await fetchSlotPage("intro-call", first.next!);
        expect(requested.map((r) => r.from)).toEqual([NOW, NOW + 30 * DAY, NOW + 60 * DAY]);
        expect(second.slots).toEqual([later]);
    });

    it("returns an empty, final page when nothing is open in the rest of the window", async () => {
        const requested = mockSlots([[], []]);
        const page = await fetchSlotPage("intro-call", initialSlotCursor(60, NOW));
        expect(requested).toHaveLength(2);
        expect(page).toEqual({ slots: [], next: null });
    });

    it("continues just after the last slot of a response restapi cut off", async () => {
        const full = Array.from({ length: MAX_SLOTS_PER_RESPONSE }, (_v, i) => slotAt(NOW + i * 60 * 60 * 1000));
        mockSlots([full]);
        const page = await fetchSlotPage("intro-call", initialSlotCursor(30, NOW));

        const lastStart = Date.parse(full[full.length - 1].start);
        expect(page.next).toEqual({ from: lastStart + 1, horizon: NOW + 30 * DAY });
    });

    it("resumes a cut-off response from just after its last slot on the next call", async () => {
        const full = Array.from({ length: MAX_SLOTS_PER_RESPONSE }, (_v, i) => slotAt(NOW + i * 15 * 60 * 1000));
        const lastStart = Date.parse(full[full.length - 1].start);
        const rest = slotAt(lastStart + 15 * 60 * 1000);
        const requested = mockSlots([full, [rest]]);

        const first = await fetchSlotPage("intro-call", initialSlotCursor(30, NOW));
        const second = await fetchSlotPage("intro-call", first.next!);

        expect(requested[1]).toEqual({ from: lastStart + 1, to: lastStart + 1 + SLOT_CHUNK_DAYS * DAY });
        expect(second.slots).toEqual([rest]);
        // The resumed chunk runs past the 30-day window, so paging ends there.
        expect(second.next).toBeNull();
    });

    it("ends a cut-off response's paging when resuming would start past the booking window", async () => {
        // A 1-day window cut off exactly at its last instant: resuming just after that slot is already outside it.
        const horizon = NOW + DAY;
        const full = Array.from({ length: MAX_SLOTS_PER_RESPONSE }, (_v, i) => slotAt(NOW + i));
        full[full.length - 1] = slotAt(horizon);
        mockSlots([full]);

        const page = await fetchSlotPage("intro-call", initialSlotCursor(1, NOW));
        expect(page.slots).toHaveLength(MAX_SLOTS_PER_RESPONSE);
        expect(page.next).toBeNull();
    });

    it("never moves backwards when a cut-off response's last slot precedes the requested window", async () => {
        // A misbehaving/out-of-order response must not rewind the cursor (which could loop forever) - it
        // falls back to continuing from the end of the requested chunk instead.
        const full = Array.from({ length: MAX_SLOTS_PER_RESPONSE }, () => slotAt(NOW - DAY));
        mockSlots([full]);

        const page = await fetchSlotPage("intro-call", initialSlotCursor(90, NOW));
        expect(page.next).toEqual({ from: NOW + SLOT_CHUNK_DAYS * DAY, horizon: NOW + 90 * DAY });
    });

    it("never requests past bookingWindowDays when every chunk is fully booked", async () => {
        const requested = mockSlots([[], [], [], []]);
        const page = await fetchSlotPage("intro-call", initialSlotCursor(45, NOW));

        // 45 days = one full chunk plus a partial one; nothing is asked for from the horizon onward.
        expect(requested.map((r) => r.from)).toEqual([NOW, NOW + 30 * DAY]);
        expect(requested.every((r) => r.from < NOW + 45 * DAY)).toBe(true);
        expect(page).toEqual({ slots: [], next: null });
    });

    it("returns an empty, final page without fetching for a cursor already at its horizon", async () => {
        const requested = mockSlots([[slotAt(NOW)]]);
        const page = await fetchSlotPage("intro-call", { from: NOW + 30 * DAY, horizon: NOW + 30 * DAY });

        expect(requested).toHaveLength(0);
        expect(page).toEqual({ slots: [], next: null });
    });

    it("appendSlots() adds only slots it doesn't already have", () => {
        const a = slotAt(NOW);
        const b = slotAt(NOW + DAY);
        expect(appendSlots([a], [a, b])).toEqual([a, b]);
    });
});
