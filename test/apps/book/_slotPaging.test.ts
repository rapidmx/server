///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import {
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

    it("skips fully booked chunks until it finds a slot", async () => {
        const later = slotAt(NOW + 65 * DAY);
        const requested = mockSlots([[], [], [later]]);
        const page = await fetchSlotPage("intro-call", initialSlotCursor(120, NOW));

        expect(requested.map((r) => r.from)).toEqual([NOW, NOW + 30 * DAY, NOW + 60 * DAY]);
        expect(page.slots).toEqual([later]);
        expect(page.next).toEqual({ from: NOW + 90 * DAY, horizon: NOW + 120 * DAY });
    });

    it("returns an empty, final page when nothing is open in the whole window", async () => {
        const requested = mockSlots([[], [], []]);
        const page = await fetchSlotPage("intro-call", initialSlotCursor(90, NOW));
        expect(requested).toHaveLength(3);
        expect(page).toEqual({ slots: [], next: null });
    });

    it("continues just after the last slot of a response restapi cut off", async () => {
        const full = Array.from({ length: MAX_SLOTS_PER_RESPONSE }, (_v, i) => slotAt(NOW + i * 60 * 60 * 1000));
        mockSlots([full]);
        const page = await fetchSlotPage("intro-call", initialSlotCursor(30, NOW));

        const lastStart = Date.parse(full[full.length - 1].start);
        expect(page.next).toEqual({ from: lastStart + 1, horizon: NOW + 30 * DAY });
    });

    it("appendSlots() adds only slots it doesn't already have", () => {
        const a = slotAt(NOW);
        const b = slotAt(NOW + DAY);
        expect(appendSlots([a], [a, b])).toEqual([a, b]);
    });
});
