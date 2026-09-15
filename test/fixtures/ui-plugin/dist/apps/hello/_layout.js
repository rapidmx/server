import { jsx, jsxs } from "react/jsx-runtime";
export default function HelloLayout({ children }) {
    return jsxs("html", { lang: "en", children: [jsxs("head", { children: [jsx("meta", { charSet: "utf-8" }), jsx("title", { children: "Hello" })] }), jsx("body", { children })] });
}
