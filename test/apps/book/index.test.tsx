// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import NoBookingSlugPage from "../../../apps/book/index.js";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("NoBookingSlugPage", () => {
    it("shows an alert that no booking link was specified", async () => {
        mockFetch((url) => {
            if (url === "/api/system/branding") return jsonResponse(200, { companyName: "", title: "" });
            throw new Error(`unexpected ${url}`);
        });
        render(<NoBookingSlugPage />);
        expect(await screen.findByText("No booking link specified.")).toBeInTheDocument();
    });
});
