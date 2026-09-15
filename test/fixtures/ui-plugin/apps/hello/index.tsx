///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import React, { useState } from "react";

interface HelloPageProps {
    pluginNav?: { settingsSections: { id: string; label: string }[] };
}

export default function HelloPage({ pluginNav }: HelloPageProps) {
    const [count, setCount] = useState(0);
    return (
        <main className="bg-fuchsia-700 p-4">
            <h1>Hello from a plugin</h1>
            <p id="plugin-settings">{(pluginNav?.settingsSections ?? []).map((section) => section.label).join(",")}</p>
            <button type="button" onClick={() => setCount(count + 1)}>
                {count}
            </button>
        </main>
    );
}
