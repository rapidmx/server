import { jsx, jsxs } from "react/jsx-runtime";
import { useState } from "react";
export default function HelloPage({ pluginNav }) {
    const [count, setCount] = useState(0);
    return jsxs("main", {
        className: "bg-fuchsia-700 p-4",
        children: [
            jsx("h1", { children: "Hello from a plugin" }),
            jsx("p", { id: "plugin-settings", children: (pluginNav?.settingsSections ?? []).map((section) => section.label).join(",") }),
            jsx("button", { type: "button", onClick: () => setCount(count + 1), children: count }),
        ],
    });
}
