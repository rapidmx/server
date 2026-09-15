///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Pages through a booking type's open slots. `@rapidmx/restapi`'s `GET /types/:slug/slots` answers one window at a
 * time (30 days when no `to` is given) and returns at most `MAX_SLOTS_PER_RESPONSE` slots, earliest first, so a single
 * unparameterized call hides everything past the first 30 days - or, for a busy host with short slots, past the first
 * 500 slots - of a longer `bookingWindowDays`. Not a page: `_`-prefixed files in `apps/` aren't routed.
 */
import { BookingSlot, getBookingSlots } from "@rapidmx/react-shared/booking/bookingApi.js";

/** restapi's `MAX_SLOTS_PER_RESPONSE`: a response this long was cut off, and its window has more slots. */
export const MAX_SLOTS_PER_RESPONSE = 500;
/** Days of availability asked for per request - restapi's own default window, which bounds its per-request work. */
export const SLOT_CHUNK_DAYS = 30;
/**
 * The most requests one `fetchSlotPage()` call makes. The slots endpoint is anonymous, so every request counts against
 * the per-IP anonymous rate limit (`rateLimit.ip`, 100 per 5 minutes by default) that every visitor behind the same NAT
 * shares: a page load must not walk a long, fully booked `bookingWindowDays` (a year is 13 chunks) on its own. Past this
 * many empty windows the page returns empty with a cursor, and the visitor asks for more with "Show later times".
 */
export const MAX_REQUESTS_PER_PAGE = 2;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Where the next page starts, and the end of the booking type's window (`bookingWindowDays` from when paging began). */
export interface SlotCursor {
    from: number;
    horizon: number;
}

export interface SlotPage {
    slots: BookingSlot[];
    /** `null` once the booking window is exhausted. */
    next: SlotCursor | null;
}

export function initialSlotCursor(bookingWindowDays: number | undefined, now: number = Date.now()): SlotCursor {
    const days: number = Number(bookingWindowDays) > 0 ? Number(bookingWindowDays) : SLOT_CHUNK_DAYS;
    return { from: now, horizon: now + days * MS_PER_DAY };
}

/**
 * The next page of slots after `cursor`: requests `SLOT_CHUNK_DAYS` at a time and moves on past windows with nothing
 * open (a fully booked stretch is not the end of availability), until it finds slots, reaches the horizon or has made
 * `MAX_REQUESTS_PER_PAGE` requests - so a page can be empty while `next` is still set. A cut-off response continues just
 * after its last slot.
 */
export async function fetchSlotPage(slug: string, cursor: SlotCursor): Promise<SlotPage> {
    let from: number = cursor.from;
    for (let request = 1; ; request++) {
        if (from >= cursor.horizon) {
            return { slots: [], next: null };
        }
        const to: number = from + SLOT_CHUNK_DAYS * MS_PER_DAY;
        const slots: BookingSlot[] = await getBookingSlots(slug, new Date(from).toISOString(), new Date(to).toISOString());
        let nextFrom: number = to;
        if (slots.length >= MAX_SLOTS_PER_RESPONSE) {
            const lastStart: number = new Date(slots[slots.length - 1].start).getTime();
            if (lastStart >= from) {
                nextFrom = lastStart + 1;
            }
        }
        const next: SlotCursor | null = nextFrom < cursor.horizon ? { from: nextFrom, horizon: cursor.horizon } : null;
        if (slots.length > 0 || !next || request >= MAX_REQUESTS_PER_PAGE) {
            return { slots, next };
        }
        from = nextFrom;
    }
}

/** `existing` followed by the slots of `more` it doesn't already have (by start). */
export function appendSlots(existing: BookingSlot[], more: BookingSlot[]): BookingSlot[] {
    const seen = new Set(existing.map((slot) => slot.start));
    return [...existing, ...more.filter((slot) => !seen.has(slot.start))];
}
