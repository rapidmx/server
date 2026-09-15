import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';
import { resolve } from 'path';

export default defineConfig({
    ssr: {
        // `@rapidrest/auth` exports classes (e.g. `DefaultAccounts`, extending `BackgroundService`) that
        // are only usable via `instanceof` checks against `@rapidrest/service-core`'s own classes if both
        // packages are resolved through the same module graph. Left external, Vite's SSR loader gives
        // `@rapidrest/auth` a *different* copy of `@rapidrest/service-core than the one `noExternal` below
        // forces everything else through, so e.g. `class.prototype instanceof BackgroundService` silently
        // comes back false and `Server.start()` never schedules the job — even though the exact same code
        // works correctly outside Vite (the real, non-test `node dist/src/server.js` runtime has only one
        // module cache to begin with).
        noExternal: ['@rapidrest/auth', '@rapidrest/service-core', '@rapidrest/core', '@rapidmx/restapi', '@rapidmx/react-shared'],
    },
    // Forces every resolution of react/react-dom to the same physical module instance - needed now
    // that apps/www/apps/admin pull hooks (useIsMobile, useBranding, ...) from the portal-linked
    // @rapidmx/react-shared package, which has its own independent node_modules (needed to run its own
    // tests standalone). Without this, a hook test could resolve two separate React instances and fail
    // with "Invalid hook call" - see vite.config.ts's identical fix for the same root cause.
    resolve: {
        dedupe: ['react', 'react-dom'],
    },
    plugins: [
        swc.vite({
            jsc: {
                parser: {
                    syntax: 'typescript',
                    tsx: true,
                    decorators: true,
                },
                transform: {
                    react: {
                        runtime: 'automatic',
                    },
                    decoratorMetadata: true,
                    legacyDecorator: true,
                },
                target: 'es2020',
            },
        }),
    ],
    test: {
        globals: true,
        // Server-side test/**/*.test.ts suite runs under plain `node`, matching the real server runtime.
        // A test that renders React components into a DOM opts into `jsdom` individually via a
        // `// @vitest-environment jsdom` docblock at its top (`environmentMatchGlobs` was removed in Vitest 4).
        environment: 'node',
        include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
        // Pins the test process's local timezone to UTC. The calendar views (MonthView/TimeGridView)
        // use date-fns's local-time-aware functions (isToday/isSameDay/startOfDay/format/...) — correct
        // behavior for a real calendar (a user views their own local time), but it means a test fixture
        // built from a UTC ISO string can silently land on the *previous* local calendar day/hour
        // depending on whichever timezone happens to run the suite (reproduced directly: a fixture of
        // "2026-06-10T00:00:00.000Z" landed on local "June 9" in this dev environment's Pacific
        // timezone). Pinning to UTC makes UTC ISO string fixtures and the components' local-time
        // calculations agree everywhere the suite runs, instead of only in whichever timezone authored
        // the test.
        env: { TZ: 'UTC' },
        fileParallelism: false,
        pool: 'forks',
        poolOptions: {
            forks: {
                execArgv: ['--no-experimental-strip-types'],
            },
        },
        clearMocks: true,
        coverage: {
            enabled: true,
            provider: 'v8',
            include: ['src/**/*.ts'],
            exclude: [
                '**/node_modules/**',
                'src/server.ts',
                'src/server.mongo.ts',
                'src/server.sql.ts',
                'src/worker.ts',
                'src/worker.mongo.ts',
                'src/worker.sql.ts',
                'src/**/Models.ts',
                '**/test/**',
            ],
            reporter: ['text', 'json', 'html', 'lcov'],
            thresholds: {
                // The backend's relaxed floor. This repo has no frontend sources left: apps/www, apps/admin and
                // apps/shared/components moved to @rapidmx/web-client (2026-09-10), and apps/book to
                // @rapidmx/booking-plugin (2026-09-15), whose own vitest configs carry the 100% frontend
                // thresholds that used to live here.
                branches: 0,
                functions: 0,
                lines: 0,
                statements: 0,
            },
            reportsDirectory: 'coverage',
        },
        reporters: ['default', 'junit'],
        outputFile: {
            junit: 'junit.xml',
        },
    },
});
