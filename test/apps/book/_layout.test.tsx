// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// `Layout` renders a full `<html>` document — it's only ever used server-side to wrap SSR output, never
// mounted client-side into an existing DOM. Rendered here via `renderToStaticMarkup` (the same kind of
// call the SSR renderer itself makes) rather than `@testing-library/react`'s `render()`, which would
// mount it inside a `<div>` and trip React's "`<html>` cannot be a child of `<div>`" nesting warning.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Layout from "../../../apps/book/_layout.js";

describe("Layout", () => {
    it("renders the document shell with the given children inside the body", () => {
        const html = renderToStaticMarkup(
            <Layout>
                <p>page content</p>
            </Layout>,
        );

        expect(html).toContain("<title>RapidMX: Book</title>");
        expect(html).toContain('charSet="utf-8"');
        expect(html).toContain('href="/favicon.ico"');
        expect(html).toContain("<body><p>page content</p></body>");
    });

    it("renders the configured title and icon when branding is supplied", () => {
        const html = renderToStaticMarkup(
            <Layout branding={{ companyName: "Acme", title: "Acme Mail", iconUrl: "https://cdn.example.com/icon.png" }}>
                <p>page content</p>
            </Layout>,
        );

        expect(html).toContain("<title>Acme Mail: Book</title>");
        expect(html).toContain('href="https://cdn.example.com/icon.png"');
        expect(html).not.toContain('rel="stylesheet"');
    });

    it("falls back to the company name for the title, and the logo for the icon", () => {
        const html = renderToStaticMarkup(
            <Layout branding={{ companyName: "Acme", title: "", logoUrl: "https://cdn.example.com/logo.svg" }}>
                <p>page content</p>
            </Layout>,
        );

        expect(html).toContain("<title>Acme: Book</title>");
        expect(html).toContain('href="https://cdn.example.com/logo.svg"');
    });

    it("links the configured custom stylesheet", () => {
        const html = renderToStaticMarkup(
            <Layout branding={{ companyName: "", title: "", stylesheetUrl: "https://cdn.example.com/brand.css" }}>
                <p>page content</p>
            </Layout>,
        );

        expect(html).toContain('<link rel="stylesheet" href="https://cdn.example.com/brand.css" id="');
        expect(html).toContain("<title>RapidMX: Book</title>");
        expect(html).toContain('href="/images/logo.svg"');
    });
});
