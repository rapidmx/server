///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import React from "react";

export default function HelloLayout({ children }: { children?: React.ReactNode }) {
    return (
        <html lang="en">
            <head>
                <meta charSet="utf-8" />
                <title>Hello</title>
            </head>
            <body>{children}</body>
        </html>
    );
}
