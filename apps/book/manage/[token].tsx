///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * `@rapidmx/restapi`'s own confirmation-email manage link embeds the token as a path segment
 * (`${mail:booking:public_url}/manage/:token`) — matching this file's own dynamic segment, so
 * `mail:booking:public_url` can now point at this route directly (see `config.mongo.ts`/`config.sql.ts`).
 */
import React, { useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import {
    BookingSlot,
    BookingStatus,
    PublicBooking,
    cancelBooking,
    getBookingByToken,
    getPublicBookingType,
    rescheduleBooking,
} from "@rapidmx/react-shared/booking/bookingApi.js";
import useBranding from "@rapidmx/react-shared/branding/useBranding.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import { BrandingFooter, BrandingHeader } from "@rapidmx/web-client/shared/components/layout/BrandingChrome.js";
import Modal from "@rapidmx/react-shared/components/overlays/Modal.js";
import { SlotCursor, appendSlots, fetchSlotPage, initialSlotCursor } from "../_slotPaging.js";

export default function ManageBookingPage({ params }: { params: { token: string } }) {
    const { branding, logoSrc } = useBranding();
    return (
        <>
            <BrandingHeader branding={branding} />
            <ManageBookingContent token={params.token} logoSrc={logoSrc} />
            <BrandingFooter branding={branding} />
        </>
    );
}

function ManageBookingContent({ token, logoSrc }: { token: string; logoSrc: string }) {
    const [booking, setBooking] = useState<PublicBooking | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [confirmingCancel, setConfirmingCancel] = useState(false);
    const [canceling, setCanceling] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);
    const [rescheduling, setRescheduling] = useState(false);
    const [slots, setSlots] = useState<BookingSlot[]>([]);
    const [slotsLoading, setSlotsLoading] = useState(false);
    const [nextSlots, setNextSlots] = useState<SlotCursor | null>(null);
    const [loadingMore, setLoadingMore] = useState(false);
    const [submittingReschedule, setSubmittingReschedule] = useState(false);

    function reload() {
        setLoading(true);
        setLoadError(null);
        getBookingByToken(token)
            .then(setBooking)
            .catch((err) => setLoadError(err instanceof ApiRequestError ? err.message : "Could not load this booking."))
            .finally(() => setLoading(false));
    }

    useEffect(reload, [token]);

    async function handleCancel() {
        setCanceling(true);
        setActionError(null);
        try {
            const updated = await cancelBooking(token);
            setBooking(updated);
            setConfirmingCancel(false);
        } catch (err) {
            setActionError(err instanceof ApiRequestError ? err.message : "Could not cancel this booking.");
        } finally {
            setCanceling(false);
        }
    }

    async function handleStartReschedule() {
        setRescheduling(true);
        setActionError(null);
        setSlotsLoading(true);
        setSlots([]);
        setNextSlots(null);
        try {
            // Paged through the booking type's whole bookingWindowDays (see _slotPaging.ts).
            const type = await getPublicBookingType(booking!.bookingTypeSlug);
            const page = await fetchSlotPage(booking!.bookingTypeSlug, initialSlotCursor(type?.bookingWindowDays));
            setSlots(page.slots);
            setNextSlots(page.next);
        } catch (err) {
            setActionError(err instanceof ApiRequestError ? err.message : "Could not load new times.");
        } finally {
            setSlotsLoading(false);
        }
    }

    async function handleLoadMore() {
        if (!nextSlots) {
            return;
        }
        setLoadingMore(true);
        setActionError(null);
        try {
            const page = await fetchSlotPage(booking!.bookingTypeSlug, nextSlots);
            setSlots((current) => appendSlots(current, page.slots));
            setNextSlots(page.next);
        } catch (err) {
            setActionError(err instanceof ApiRequestError ? err.message : "Could not load more times.");
        } finally {
            setLoadingMore(false);
        }
    }

    async function handleReschedule(slot: BookingSlot) {
        setSubmittingReschedule(true);
        setActionError(null);
        try {
            const updated = await rescheduleBooking(token, slot.start);
            setBooking(updated);
            setRescheduling(false);
        } catch (err) {
            setActionError(err instanceof ApiRequestError ? err.message : "Could not reschedule this booking.");
        } finally {
            setSubmittingReschedule(false);
        }
    }

    return (
        <div className="min-h-screen bg-surface-alt flex flex-col items-center py-10 px-4">
            <img src={logoSrc} width="64" height="64" alt="" className="mb-4" />
            <div className="w-full max-w-lg bg-surface border border-border rounded-md p-6">
                {loading ? (
                    <p className="text-sm text-text-muted">Loading&hellip;</p>
                ) : loadError || !booking ? (
                    <Alert>{loadError ?? "Booking not found."}</Alert>
                ) : (
                    <div className="flex flex-col gap-4">
                        <div>
                            <h1 className="text-lg font-bold tracking-tight mb-1">{booking.name}</h1>
                            <p className="text-sm text-text-muted">with {booking.hostDisplayName}</p>
                        </div>

                        {actionError && <Alert>{actionError}</Alert>}

                        {booking.status === BookingStatus.CANCELLED ? (
                            <p className="text-sm font-medium text-text-muted">This booking has been cancelled.</p>
                        ) : (
                            <>
                                <p className="text-sm">
                                    <strong>{new Date(booking.startDate).toLocaleString()}</strong>
                                </p>
                                {booking.status === BookingStatus.PENDING && (
                                    <p className="text-xs text-text-muted">Awaiting the host&rsquo;s confirmation.</p>
                                )}

                                {!rescheduling ? (
                                    <div className="flex gap-2">
                                        <Button type="button" variant="secondary" className="!w-auto" onClick={handleStartReschedule}>
                                            Reschedule
                                        </Button>
                                        <Button
                                            type="button"
                                            variant="secondary"
                                            className="!w-auto !border-danger !text-danger hover:!border-danger hover:!text-danger"
                                            onClick={() => setConfirmingCancel(true)}
                                        >
                                            Cancel booking
                                        </Button>
                                    </div>
                                ) : (
                                    <div>
                                        <h2 className="text-sm font-semibold mb-2">Choose a new time</h2>
                                        {slotsLoading ? (
                                            <p className="text-sm text-text-muted">Loading&hellip;</p>
                                        ) : slots.length === 0 ? (
                                            <p className="text-sm text-text-muted">No open slots right now.</p>
                                        ) : (
                                            <div className="flex flex-wrap gap-2 max-h-64 overflow-y-auto">
                                                {slots.map((slot) => (
                                                    <button
                                                        key={slot.start}
                                                        type="button"
                                                        disabled={submittingReschedule}
                                                        onClick={() => handleReschedule(slot)}
                                                        className="text-sm py-1.5 px-3 border border-border rounded-sm hover:border-primary hover:text-primary-dark disabled:opacity-55"
                                                    >
                                                        {new Date(slot.start).toLocaleString(undefined, {
                                                            month: "short",
                                                            day: "numeric",
                                                            hour: "numeric",
                                                            minute: "2-digit",
                                                        })}
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                        {!slotsLoading && nextSlots && (
                                            <Button
                                                type="button"
                                                variant="secondary"
                                                className="!w-auto mt-2"
                                                loading={loadingMore}
                                                disabled={loadingMore || submittingReschedule}
                                                onClick={handleLoadMore}
                                            >
                                                Show later times
                                            </Button>
                                        )}
                                        <Button
                                            type="button"
                                            variant="text"
                                            className="mt-2"
                                            disabled={submittingReschedule}
                                            onClick={() => setRescheduling(false)}
                                        >
                                            Never mind
                                        </Button>
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                )}
            </div>

            <Modal open={confirmingCancel} onClose={() => setConfirmingCancel(false)} title="Cancel booking">
                <p className="text-sm mb-5">Are you sure you want to cancel this booking? This cannot be undone.</p>
                <div className="flex gap-3 justify-end">
                    <Button
                        type="button"
                        variant="secondary"
                        className="!w-auto"
                        disabled={canceling}
                        onClick={() => setConfirmingCancel(false)}
                    >
                        Never mind
                    </Button>
                    <Button
                        type="button"
                        className="!w-auto !bg-none !bg-danger !border-danger hover:!bg-danger"
                        loading={canceling}
                        disabled={canceling}
                        onClick={handleCancel}
                    >
                        Cancel booking
                    </Button>
                </div>
            </Modal>
        </div>
    );
}
