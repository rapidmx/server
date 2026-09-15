import { createServerViteConfig } from "./src/lib/serverViteConfig.js";

// The image's prebuilt browser bundles (`dist/public`): the core apps only. The app list, the React dedupe and the
// stylesheet wiring live in src/lib/serverViteConfig.ts, which PluginUiBuilder also uses to rebuild at startup with the
// enabled plugins' UI apps added.
export default async function () {
    return await createServerViteConfig();
}
