import { jsxs } from "react/jsx-runtime";
export default function GreetNamePage({ params }) {
    return jsxs("main", { className: "text-emerald-600", children: ["Greetings, ", params?.name] });
}
