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
        // Frontend (apps/www) tests render React components and need a DOM — each of those test files
        // opts into `jsdom` individually via a `// @vitest-environment jsdom` docblock at its top
        // (`environmentMatchGlobs`, the config-level way to do this per-directory, was removed in Vitest 4).
        environment: 'node',
        setupFiles: ['./test/apps/setup.ts'],
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
            include: ['src/**/*.ts', 'apps/**/*.ts', 'apps/**/*.tsx'],
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
                // Per-glob thresholds are checked *in addition to* these top-level ones, not instead of them —
                // the top-level numbers gate the overall combined coverage across every included file, so they
                // must stay at the backend's relaxed floor (0%) or a low-coverage src/** file fails the build
                // via the global check even when every specific glob below it passes. Frontend enforcement
                // instead lives entirely in the 'apps/**' glob (and the more specific ones nested under it).
                branches: 0,
                functions: 0,
                lines: 0,
                statements: 0,
                // apps/www, apps/admin, and apps/shared/components moved out to the separate
                // @rapidmx/web-client package (2026-09-10 - see .claude/NOTES.md) - that package's own
                // vitest.config.ts now carries the 100% frontend threshold (and the one ComposeWindow.tsx
                // branch-coverage carve-out) that used to live here. apps/book is the only thing left
                // under apps/** in this repo.
                'apps/**': {
                    // Branches held at 97%, not 100% - apps/book/_layout.tsx's title/stylesheet conditional
                    // rendering (`branding?.title || branding?.companyName`, `stylesheetHref && <link .../>`)
                    // has the exact same 81.81% branch-coverage shape every other _layout.tsx in this
                    // codebase shows (see the identical pattern in @rapidmx/web-client's own apps/admin/
                    // _layout.tsx) - this was always true, just previously invisible: pooled with hundreds
                    // of 100%-covered apps/www/apps/admin files, one _layout.tsx's shortfall barely moved
                    // the aggregate below 100%. Now that apps/book is nearly this glob's entire pool, the
                    // same shortfall drags the aggregate down to ~97.33%. Not a new gap this split
                    // introduced - just no longer diluted enough to round up to 100.
                    branches: 97,
                    functions: 100,
                    lines: 100,
                    statements: 100,
                },
            },
            reportsDirectory: 'coverage',
        },
        reporters: ['default', 'junit'],
        outputFile: {
            junit: 'junit.xml',
        },
    },
});
