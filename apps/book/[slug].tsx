///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, useEffect, useMemo, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import {
    BookingSlot,
    PublicBookingType,
    bookSlot,
    bookingManageUrl,
    getPublicBookingType,
} from "@rapidmx/react-shared/booking/bookingApi.js";
import useBranding from "@rapidmx/react-shared/branding/useBranding.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import { BrandingFooter, BrandingHeader } from "@rapidmx/web-client/shared/components/layout/BrandingChrome.js";
import { SlotCursor, appendSlots, fetchSlotPage, initialSlotCursor } from "./_slotPaging.js";

const INPUT_CLASS =
    "w-full text-sm py-2.5 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";

/** Groups `slots` by the visitor's own local calendar date (via `toLocaleDateString()`, which reads the
 * browser's timezone) — slots themselves are absolute instants, so "today"/"tomorrow" naturally differ
 * per visitor without any manual timezone math here. */
function groupByLocalDate(slots: BookingSlot[]): Map<string, BookingSlot[]> {
    const groups = new Map<string, BookingSlot[]>();
    for (const slot of slots) {
        const key = new Date(slot.start).toLocaleDateString(undefined, {
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
        });
        const existing = groups.get(key);
        if (existing) {
            existing.push(slot);
        } else {
            groups.set(key, [slot]);
        }
    }
    return groups;
}

export default function PublicBookingPage({ params }: { params: { slug: string } }) {
    const { branding, logoSrc } = useBranding();
    return (
        <>
            <BrandingHeader branding={branding} />
            <BookingContent slug={params.slug} logoSrc={logoSrc} />
            <BrandingFooter branding={branding} />
        </>
    );
}

function BookingContent({ slug, logoSrc }: { slug: string; logoSrc: string }) {
    const [bookingType, setBookingType] = useState<PublicBookingType | null>(null);
    const [slots, setSlots] = useState<BookingSlot[]>([]);
    const [nextSlots, setNextSlots] = useState<SlotCursor | null>(null);
    const [loadingMore, setLoadingMore] = useState(false);
    const [moreError, setMoreError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [selectedSlot, setSelectedSlot] = useState<BookingSlot | null>(null);
    const [bookerName, setBookerName] = useState("");
    const [bookerEmail, setBookerEmail] = useState("");
    const [bookerNotes, setBookerNotes] = useState("");
    const [booking, setBooking] = useState(false);
    const [bookError, setBookError] = useState<string | null>(null);
    const [confirmed, setConfirmed] = useState(false);
    const [manageUrl, setManageUrl] = useState<string | null>(null);

    useEffect(() => {
        setLoading(true);
        setLoadError(null);
        setMoreError(null);
        // The booking type says how far ahead it can be booked; slots are then paged through that whole window
        // (see _slotPaging.ts), not just the first response's 30 days / 500 slots.
        getPublicBookingType(slug)
            .then(async (type) => {
                const page = type ? await fetchSlotPage(slug, initialSlotCursor(type.bookingWindowDays)) : { slots: [], next: null };
                setBookingType(type);
                setSlots(page.slots);
                setNextSlots(page.next);
            })
            .catch((err) => setLoadError(err instanceof ApiRequestError ? err.message : "Could not load this booking page."))
            .finally(() => setLoading(false));
    }, [slug]);

    async function handleLoadMore() {
        if (!nextSlots) {
            return;
        }
        setLoadingMore(true);
        setMoreError(null);
        try {
            const page = await fetchSlotPage(slug, nextSlots);
            setSlots((current) => appendSlots(current, page.slots));
            setNextSlots(page.next);
        } catch (err) {
            setMoreError(err instanceof ApiRequestError ? err.message : "Could not load more times.");
        } finally {
            setLoadingMore(false);
        }
    }

    const grouped = useMemo(() => groupByLocalDate(slots), [slots]);

    async function handleSubmit(e: FormEvent) {
        e.preventDefault();
        setBookError(null);
        if (!bookerName.trim() || !bookerEmail.trim()) {
            setBookError("Your name and email are both required.");
            return;
        }
        setBooking(true);
        try {
            const result = await bookSlot(slug, {
                start: selectedSlot!.start,
                bookerName: bookerName.trim(),
                bookerEmail: bookerEmail.trim(),
                bookerNotes: bookerNotes.trim() || undefined,
                bookerTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            });
            setManageUrl(result.manageToken ? bookingManageUrl(result.manageToken) : null);
            setConfirmed(true);
        } catch (err) {
            setBookError(err instanceof ApiRequestError ? err.message : "Could not book this slot.");
        } finally {
            setBooking(false);
        }
    }

    return (
        <div className="min-h-screen bg-surface-alt flex flex-col items-center py-10 px-4">
            <img src={logoSrc} width="64" height="64" alt="" className="mb-4" />
            <div className="w-full max-w-lg bg-surface border border-border rounded-md p-6">
                {loading ? (
                    <p className="text-sm text-text-muted">Loading&hellip;</p>
                ) : loadError || !bookingType ? (
                    <Alert>{loadError ?? "This booking link is not available."}</Alert>
                ) : confirmed && selectedSlot ? (
                    <div>
                        <h1 className="text-lg font-bold tracking-tight mb-2">You&rsquo;re booked!</h1>
                        <p className="text-sm text-text mb-4">
                            {bookingType.name} with {bookingType.hostDisplayName} on{" "}
                            {new Date(selectedSlot.start).toLocaleString()}.
                        </p>
                        {manageUrl && (
                            <>
                                <p className="text-sm text-text-muted mb-1">Save this link to cancel or reschedule later:</p>
                                {/* Only ever rendered after a client-side `bookSlot()` success (`confirmed` starts
                                `false` and is never true on the server), so `window` is always defined here. */}
                                <a href={manageUrl} className="text-sm text-primary-dark hover:underline break-all">
                                    {window.location.origin}
                                    {manageUrl}
                                </a>
                            </>
                        )}
                    </div>
                ) : (
                    <div>
                        <h1 className="text-lg font-bold tracking-tight mb-1">{bookingType.name}</h1>
                        <p className="text-sm text-text-muted mb-1">with {bookingType.hostDisplayName}</p>
                        {bookingType.description && <p className="text-sm text-text mt-2 mb-4">{bookingType.description}</p>}
                        <p className="text-xs text-text-muted mb-4">{bookingType.durationMinutes} minutes</p>

                        {!selectedSlot ? (
                            slots.length === 0 ? (
                                <p className="text-sm text-text-muted">No open slots right now — please check back later.</p>
                            ) : (
                                <div className="flex flex-col gap-4 max-h-96 overflow-y-auto">
                                    {[...grouped.entries()].map(([date, daySlots]) => (
                                        <div key={date}>
                                            <h2 className="text-sm font-semibold mb-2">{date}</h2>
                                            <div className="flex flex-wrap gap-2">
                                                {daySlots.map((slot) => (
                                                    <button
                                                        key={slot.start}
                                                        type="button"
                                                        onClick={() => setSelectedSlot(slot)}
                                                        className="text-sm py-1.5 px-3 border border-border rounded-sm hover:border-primary hover:text-primary-dark"
                                                    >
                                                        {new Date(slot.start).toLocaleTimeString(undefined, {
                                                            hour: "numeric",
                                                            minute: "2-digit",
                                                        })}
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    ))}
                                    {moreError && <Alert>{moreError}</Alert>}
                                    {nextSlots && (
                                        <Button
                                            type="button"
                                            variant="secondary"
                                            className="!w-auto self-start"
                                            loading={loadingMore}
                                            disabled={loadingMore}
                                            onClick={handleLoadMore}
                                        >
                                            Show later times
                                        </Button>
                                    )}
                                </div>
                            )
                        ) : (
                            <form onSubmit={handleSubmit} className="flex flex-col gap-3">
                                <p className="text-sm">
                                    <strong>{new Date(selectedSlot.start).toLocaleString()}</strong>
                                </p>
                                {bookError && <Alert>{bookError}</Alert>}
                                <input
                                    aria-label="Your name"
                                    type="text"
                                    placeholder="Your name"
                                    className={INPUT_CLASS}
                                    value={bookerName}
                                    onChange={(e) => setBookerName(e.target.value)}
                                />
                                <input
                                    aria-label="Your email"
                                    type="email"
                                    placeholder="Your email"
                                    className={INPUT_CLASS}
                                    value={bookerEmail}
                                    onChange={(e) => setBookerEmail(e.target.value)}
                                />
                                <textarea
                                    aria-label="Notes (optional)"
                                    placeholder="Notes (optional)"
                                    rows={3}
                                    className={INPUT_CLASS}
                                    value={bookerNotes}
                                    onChange={(e) => setBookerNotes(e.target.value)}
                                />
                                <div className="flex gap-2">
                                    <Button type="submit" loading={booking} disabled={booking} className="!w-auto">
                                        Confirm booking
                                    </Button>
                                    <Button
                                        type="button"
                                        variant="secondary"
                                        disabled={booking}
                                        className="!w-auto"
                                        onClick={() => setSelectedSlot(null)}
                                    >
                                        Choose a different time
                                    </Button>
                                </div>
                            </form>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
