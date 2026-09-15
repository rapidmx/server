import tailwindcss from "@tailwindcss/vite";
import { createViteConfig } from "@rapidrest/react/vite";

// `resolve.dedupe` forces every resolution of react/react-dom to the SAME physical module instance,
// regardless of how many copies exist on disk - needed now that apps/www/apps/admin pull hooks
// (useIsMobile, useBranding, ...) from the portal-linked @rapidmx/react-shared package, which has its
// own independent node_modules (needed to run its own tests standalone). Without this, Vite would
// resolve two separate React instances (this project's vs. react-shared's own devDependency copy),
// breaking every hook react-shared exports with "Invalid hook call" - the exact class of bug
// .claude/NOTES.md already documents for portal:-linked packages, there for @rapidrest/core's
// instanceof-based DI instead of React's hook dispatcher, same root cause either way.
// Vite always transforms raw TSX source directly (its own JSX transform, independent of whatever the
// SSR runtime does) - unlike WwwRoute/AdminConsoleRoute's appDir (see webClientAppDir.ts), this never
// needs to point at @rapidmx/web-client's compiled dist/apps/** mirror, only its source. apps/book stays
// local to this repo (not part of the web-client/react-shared split - see .claude/NOTES.md).
export default async function () {
    const config = await createViteConfig({
        appDir: [
            "node_modules/@rapidmx/web-client/apps/www",
            "node_modules/@rapidmx/web-client/apps/admin",
            "node_modules/@rapidmx/web-client/apps/escrow",
            "apps/book",
        ],
        plugins: [tailwindcss()],
    });
    return {
        ...config,
        resolve: {
            ...config.resolve,
            dedupe: ["react", "react-dom"],
        },
    };
}
