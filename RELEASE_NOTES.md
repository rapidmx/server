# Release Notes

## Unreleased

## v1.0.0-beta.16

### Added

- **The Helm chart installs a TURN server (coturn) for video calls, and wires the Video Conferencing plugin to it.** A participant behind a strict firewall or NAT can't be connected directly and needs a relay; without one they couldn't join. `coturn.create` (on by default) runs coturn on the node's own network (TURN is UDP, which the Gateway can't carry). By default every participant is given a credential of their own when they join a call, made from a secret only the server and coturn know and good for an hour (`coturn.auth.mode: secret`); `credential` mode uses one pre-set user name and password instead. The secret is generated once and kept across upgrades in a Secret that both coturn and the server pod read, and the server gets `mail:videoconf:turn:url` and `:shared_secret` (or `:username` and `:credential`) from it, so calls use it as installed; a setting saved in the plugin's admin console still wins. `coturn.tls.enabled` adds TURN over TLS (`turns:`) for networks that block everything but TLS, using the certificate the chart already issues for its host (or a Secret you supply) and picking up its renewals without a restart; it needs a Video Conferencing plugin of version 0.4.0 or later. coturn refuses to relay to private, loopback and link-local addresses, so it can't be used to reach the node's or the cluster's own network. It needs `coturn.hostname` (default: the server's host) to resolve to the node's public address, and TCP and UDP 3478, TCP 5349 (with TLS) and UDP 49152-49252 open to the internet: `single_node_install.sh` opens them; the AWS template leaves coturn off (its instance address isn't fixed and its load balancer carries no UDP). Turn it off with `coturn.create=false`.

- **Outlook and ActiveSync can sign in with a username and an app password.** Those clients can only send HTTP Basic credentials, and the server accepted only a JWT, so they could never authenticate. On `/mapi` and `/Microsoft-Server-ActiveSync` (`mail:basic_auth:paths`) a `Basic` header is now checked by the auth-server (`GET /api/auth/password`, whose rules for two-factor accounts still apply - an account that requires MFA can only use an app password) and answered with an ordinary access token that the existing JWT check verifies. A username that is a mailbox address is checked as the mailbox's owner. A 401 on those paths carries `WWW-Authenticate: Basic realm="RapidMX"`, which is what makes a client ask for credentials. Basic is accepted nowhere else - an app password skips the second factor and is for exactly these clients. A successful sign-in is remembered for 5 minutes (`cache_ttl_ms`, never past the token's expiry) because these clients send their credentials with every request; 10 failed sign-ins per client address or per username in 15 minutes get a 429 until the window passes, so a guessing client is stopped before it reaches the auth-server. Helm: `mail.basicAuth.{enabled,realm,cacheTtlMs,failureLimit}` render as `mail__basic_auth__*`, and `auth__app_password__enabled: true` is now set on the bundled auth-server explicitly. Not verified against a real Outlook client.

### Changed

- **Meeting invitations can be answered from the message and the message list, events have descriptions, visibility, guest permissions and a Find a time tab, and the calendar's New event popover has Task and Appointment schedule tabs.** Bundles `@rapidmx/restapi` 0.21.1, `@rapidmx/react-shared` 0.16.0 and `@rapidmx/web-client` 0.15.1: Accept, Tentative, Decline and Propose new time on an invitation, an RSVP chip in the message list, a read-only event view before editing, a Google-style quick-create popover, a rich-text event description, private and confidential events shown as Busy on shared calendars, hidden guest lists and guests' change requests, a free/busy lookup with a per-mailbox visibility setting (Profile page), and the fix for an event saved from a clicked time slot crashing the calendar page. The bundled plugins (`latest`) pick up meet-plugin 0.4.1, which writes the per-guest join links a video meeting's invitation needs, and booking-plugin 0.5.1.
- **Plugins whose settings name this server's host work as installed.** A setting whose default is `https://<host>/meet` (video-conferencing's join page) or `https://<host>` (Autodiscover's public server URL) is saved with the real host when the plugin is installed - the address the admin console was reached at, or, for the default plugins seeded at first start, `mail:dns:mx_hostname` (the chart sets it) - so calendar invites carry join links and Autodiscover answers without a visit to the plugin's settings. Needs `@rapidmx/restapi` with `<host>` defaults.

## v1.0.0-beta.15

### Fixed

- **Bumped the bundled `auth-server` chart to `1.0.0-beta.21`, which fixes the sign-in page (and the sign-up, authorize, elevate and admin detail pages) answering 500.** Auth-server `1.0.0-beta.18` through `1.0.0-beta.20` shipped a client build with no entry for any nested non-index page, because a dependency update had moved `@rapidrest/react` back to 1.x. Nobody could sign in to a deployment running those versions.

## v1.0.0-beta.14

### Changed

- **Bumped the bundled `auth-server` chart to `1.0.0-beta.20`,** which carries the same no-resource-limits and MongoDB `Recreate` fixes as this chart. This chart's own `authserver.mongodb`/`authserver.redis` overrides for them are removed, since the subchart now provides them itself.

- **The Helm chart no longer sets any resource limits - only minimum requests.** Limits throttle a pod's CPU or kill it on memory even when the node has plenty to spare; on the live test host MongoDB's liveness probe was timing out at its 750m CPU cap and restarting the pod (9 restarts in 4 days). MongoDB and Redis (this chart's and the bundled auth-server chart's) now set Bitnami's `resourcesPreset: none` with the same requests the preset used to give them, and the postfix-bridge subchart's default Postfix and bridge memory limits are removed. `single_node_install.sh`'s OpenBao unsealer sidecar no longer carries a memory limit either. Every request is unchanged, so scheduling is unaffected. `helm template` prints two harmless "cannot overwrite table with non table" warnings for the postfix-bridge overrides until that chart drops its own defaults.

- **MongoDB's Deployment now uses the `Recreate` update strategy** (this chart's and the bundled auth-server chart's). With `RollingUpdate` the replacement pod could not start while the old one still held the data directory's lock (it exited with code 100), and because the old pod is only retired once the new one is Ready, any change to MongoDB's pod spec deadlocked the whole `helm upgrade` and left the release `failed`. Found while validating the resource-limit change on the live test host.

## v1.0.0-beta.13

### Security

- **The dev-only mock impersonation "stop" endpoint now matches the real one's CSRF-hardened contract.**
  `DevImpersonationRoute`'s `/impersonate/stop` (only ever mounted under `yarn dev`, mirroring
  `@rapidrest/auth`'s `BaseImpersonationRoute` for local development without a real auth-server) changed
  from `GET` to `POST`, as part of a coordinated cross-repo CSRF hardening pass (`@rapidrest/service-core`,
  `@rapidrest/auth`, `@rapidrest/auth-server`, `@rapidmx/react-shared`). A state-changing `GET` is
  exploitable via a bare cross-site/same-site navigation - no form or script required - which bypasses
  CSRF defenses entirely, since they only ever apply to non-safe methods.
- **`NODE_ENV=test` no longer bypasses the production-secrets guard.** `assertProductionSecretsAreSet()` previously treated `dev`, `development` and `test` alike, so an operator who left `NODE_ENV=test`
  set on a real deployment would boot with the checked-in default `cookie_secret`/`auth:secret`/`mail:transport:ingest:secret` still in effect - letting anyone forge a JWT or call the internal
  `/internal/mta/deliver` hand-off route directly. Only an explicit `dev` or `development` now skips this check; `test` is treated the same as an unset or unexpected `NODE_ENV` and must set its own
  secrets. The test suite itself runs under `NODE_ENV=test` but never exercises this guard as a side effect (see `config.defaults.ts`'s `SECRETS_GUARD_SKIP_ENVIRONMENTS`), so nothing else changes.
- **Bumped `@rapidmx/react-shared` to `^0.14.0`**, which carries two real security fixes: session keys are no longer extractable, and a gap in the SVG/MathML sanitizer is closed. The dependency was
  still pinned to `^0.13.0`; being pre-1.0, caret semantics meant that could never auto-resolve to 0.14.0 on its own.
- **`GET mail/messages/:id/raw` now has its own tighter per-user rate limit** (300 requests per 60 seconds, counted per user across *all* messages), instead of falling to the generous default
  "authenticated" tier. It loads a whole raw MIME blob into memory per request - up to the compose attachment cap (25MB default) for a composed message, unbounded for inbound mail. It is enforced
  in the route itself rather than with `@RateLimit()`, whose per-route counter would have given every message id its own fresh bucket.
- **A purge hook's scratch install can no longer outlive its own timeout.** `InstallingPurgeHookRunner.run()` raced a fresh, never-connected `AbortController` against the install step, so nothing
  actually stopped the underlying `npm` child process when the outer `system:plugins:purge:hook_timeout_ms` (default 60s) fired - it kept running for up to `system:plugins:npm_timeout_ms` (default
  10 minutes) in the background while the purge reported failure and moved on, and since the scratch directory is deterministic per plugin name, a retried purge could launch a second `npm install` into
  the same directory as the still-running first one. `runNpm()`/`PluginInstaller.install()` now take an `AbortSignal` that actually kills the `execFile` child process, threaded through the same way the
  hook-function call already was.
- **Capped the total size of a freshly-installed `node_modules`** (`system:plugins:max_install_bytes`, default 500MB) as defense in depth against a malicious or compromised registry package: an install
  that exceeds it is refused entirely (the same as an npm failure) and the oversized `node_modules` is removed. `--ignore-scripts` already stops an install script from running; this only bounds disk
  usage.
- **DoH MX/SRV answers with a non-numeric or out-of-range priority/weight/port are now refused outright** instead of silently producing a `NaN` field that could propagate into whatever compares or sorts
  it. `DohDnssecDnsResolver`'s `parseMxRecord()`/`parseSrvRecord()` throw on a malformed answer.

### Fixes

- **`GET mail/messages/:id/raw` (the raw RFC 5322 MIME source used for client-side E2E decrypt/signature verification) now sends `X-Content-Type-Options: nosniff`,** matching every other file-serving
  path in this repo. It was already served with `content-type: message/rfc822` rather than `text/html`, but the missing header meant an older or misconfigured browser could still be talked into sniffing
  and rendering the unsanitized raw mail source.
- **Removed three orphaned Yarn patch files** (`@rapidmx-restapi-npm-0.12.0-*.patch`, `@rapidmx-web-client-npm-0.6.0-*.patch`, `@rapidmx-react-shared-npm-0.6.0-*.patch`, the last found alongside the
  `react-shared` version bump above) that were no longer wired up in `package.json`'s `resolutions` and whose fixes had already landed upstream in the versions this repo actually depends on
  (`@rapidmx/restapi@^0.19.0`, `@rapidmx/web-client@^0.13.0`, `@rapidmx/react-shared@^0.14.0`) - they were inert on disk either way, but left the impression a patched fix was still in effect when it
  was not.
- **De-duplicated the `worker.ts`/`worker.mongo.ts`/`worker.sql.ts` DI-token registration** (BlobStore, SearchProvider, the scan/mail-transport providers, DnsResolver, DkimKeyProvider,
  EncryptionCertificateAuthority, SigningCertificateEnrollment) into one shared `registerCoreProviders()` (`src/lib/registerCoreProviders.ts`), called identically from all three entry points. The
  previous hand-kept-identical copies had already silently drifted twice (a missing `NodeDnsResolver`, then a missing `EncryptionCertificateAuthority`/`SigningCertificateEnrollment`); a newly-introduced
  token now only needs to be added in one place.
- **Plugin purge no longer blocks the event loop walking a large `node_modules` tree.** `PluginPurgeFiles.ts`'s file deletion (routinely thousands of files for a plugin's full dependency tree, retried
  on every purge attempt) now walks and removes with `fs.promises` (`removeContainedAsync()`) instead of the fully-synchronous `*Sync` calls, so a large or slow delete no longer stalls the whole process
  - which also serves live HTTP/mail traffic - for its entire duration.
- **Draft autosave always checks for a legal hold before deleting a replaced draft body.** A short-lived per-mailbox cache of that check was tried and removed: a hold placed just after a cached
  "not held" answer would have let the next autosave permanently delete a body the hold should have preserved.
- **A failed plugin install's own npm output is now truncated before it's kept.** Previously, npm's full stderr/stdout (up to `execFile`'s 16MB `maxBuffer`) became every affected plugin's error message
  and was folded into the status `JSON.stringify`'d into the shared `plugins:status` Redis key on every heartbeat for as long as the failure persisted. It's now capped at a few KB
  (`NPM_ERROR_MESSAGE_MAX_CHARS`).

## v1.0.0-beta.12

## v1.0.0-beta.11

### Security

- **An administrator could read every user's mail through the ordinary mail API - fixed.** Any signed-in administrator holding an *elevated* token (the admin console has every administrator elevate) was
  treated by the framework as a superuser on mail data: `GET /api/mail/mailboxes` listed every mailbox and the folders, messages, message content, attachments, contacts, events, tasks, notes, search results and
  live push channels of any of them answered, and the web client's mailbox switcher and Settings "Mailbox" dropdown listed everybody's mailbox. **Affected: any administrator who elevated, against any user's
  mailbox; a sign-in that did not elevate (its roles empty) never had this, so users' mail was not exposed to other users.** Now an administrator sees only their own mailbox and the mailboxes shared with them -
  in the mail client and its settings - and reaches anyone else's account only by choosing "Impersonate this user" on the mailbox page. This release's `@rapidmx/restapi` (see its release notes for the full policy)
  does the check in one place; here:
  - the admin console lists and opens mailboxes through the new administration scope (`?scope=admin`: administrative details only - addresses, owner, quota, resource settings - never mail or settings, and every call
    is written to the audit log), shows a note saying so, and replaces "Access this mailbox" with "Impersonate this user";
  - **Shared access** on a mailbox page now uses the audited Sharing endpoints: an administrator can review any mailbox's members and revoke any of them, and can add themselves (or anyone) to a *shared* mailbox
    with no owner - how an existing one such as `hello@` becomes visible in their mail client - but cannot grant access to a mailbox that has an owner (that is the owner's to give);
  - `/api/acls` no longer lets a trusted role read or change the ACLs that decide who reads a mailbox (a mailbox's, a folder's, the `Mailbox` class ACL), the raw-message and compose routes no longer honour a trusted
    role, and the live push channels are granted by ownership or an explicit share only;
  - unchanged by design: a data-subject export (`/api/mail/data-export-requests`) can still be requested for and downloaded from any mailbox by an administrator - every request and every download by someone
    other than the owner is audited (`data_export.downloaded`) - and erasure, retention, legal hold and eDiscovery keep their own approvals.
  - Rollout: nothing to configure or migrate. Deploy; an administrator's existing elevated session stops showing other people's mail immediately. The admin console asks for nothing new.

### Fixes

- **Autodiscover never actually worked - the setting it needs had no default anywhere.** Added the missing `autodiscover: { public_url: "" }` config block (an administrator sets it from the admin
  console's Plugins page, same as `mail:booking:public_url`) - without it, `@rapidmx/autodiscover-plugin` silently 404'd every request regardless of DNS. The domain DNS setup checklist now also
  recommends the `autodiscover.<domain>` CNAME and `_autodiscover._tcp.<domain>` SRV records a real EAS/Outlook client needs to find this server in the first place.
- **Requesting a digital-signature certificate could sit "pending" forever with no way to tell why, and no way for an administrator to finish it - fixed.** The chart's default backend
  (`mail.signingEnrollment.backend: auto`, `manual` for a local/test domain) waited for a certificate to be uploaded through an admin route that didn't exist yet, while Settings > Encryption said a
  public certificate authority issues it automatically - true only once `mail.signingEnrollment.backend` resolves to `rfc8823`. Every signing-certificate status now names its `provider`
  (`"manual"`/`"rfc8823"`), a new **Signing Certificates** admin page (`/api/admin/signing-enrollments`, mounted Mongo+SQL) lets an administrator download a request's CSR, upload the certificate a
  CA issued, or reject a request with a reason its owner sees, and `GET /api/system/signing-enrollment` (any signed-in user) says which backend is active, whether it's automatic, the certificate
  authority's host, a typical duration and the background job's last contact with it. A stale enrollment id (left over from switching backends) now answers 404 `signing-enrollment-unknown` instead
  of a dead end, and cancelling one is idempotent. See the README's "Signing certificates" for the chart's `mail.signingEnrollment.*` values and a switch-to-automatic runbook.
- **An unreachable signing-certificate authority was invisible beyond a per-tick debug log line - it now surfaces.** `AcmeEnrollmentDriverJob` logs a warning once when the certificate authority starts
  failing (and again only if the failure changes, not every 5 minutes), an info line once it answers again, and after `mail:jobs:acme_enrollment_driver:failure_audit_after` (3) failed checks in a row
  writes one audit entry an administrator sees in the audit log - all from the unreleased `@rapidmx/restapi`.
- **A shared mailbox that was granted to a username showed up for nobody - sharing now resolves who it grants to (live example: `hello@powerlevel.gg`, "Support", granted to `jean-philippe`).** The admin console stored the text typed in the Sharing form; an ACL record matches only a user's uid, so the grant never applied and the mailbox was visible only through the trusted-role bypass the privacy fix
  above removes. The console's **Shared access** and the mail client's **Settings > Sharing** page now look up who was typed (a mailbox address, a username or an e-mail alias, or a user id), show the person's name and address, and grant that user's id; an entry that was never a user id is flagged "has no effect" with **Replace with a user**. `/api/acls` refuses non-uid principals on mailbox ACLs. **The existing `hello@` grant
  is not migrated** (usernames are never matched to uids: they can be released and re-claimed): open the mailbox in the admin console and use **Replace with a user** on the `jean-philippe` entry, or **Add me**.

### Features

- **Per-user appearance preferences:** the server mounts `AppearanceRoute` at `/api/mail/preferences/appearance` (Mongo and SQL): `GET`/`PUT` for the theme mode, colours and window background, `POST`/`GET`/`DELETE .../background` for a background
  image (PNG, JPEG, WebP or AVIF, recognised by its bytes, at most `mail:preferences:background_max_bytes` = 8 MiB; owner-only, immutable-cacheable), and a live update on the user's own channel. The `AppearancePreferences*` models are
  registered in `Models.ts` (a new collection/table on the next start, `synchronize` on, no migration), and `WwwRoute`/`AppRoute` return the signed-in user's saved preferences as the `appearance` page prop (a single read that never fails the page),
  so the web client can theme the first byte of HTML. The cached page can show the previous value for up to a minute after a change (`ReactRoute`'s 60 s cache); the client corrects it after hydration. Needs the next `@rapidmx/restapi`.
- **Send in the background:** `POST /api/mail/messages/:id/send` with `{ "background": true }` answers `202` at once and relays in this process; `send-succeeded`/`send-retrying`/`send-failed` events carry the outcome. `mail:jobs:scheduled_send:concurrency` (4) and `mail:jobs:scheduled_send:drain_ms`
  (15000) are in the shipped configs. Also from the new `@rapidmx/restapi`: a message the mail system refuses for good is failed at once instead of retried five times, and a scheduled send is relayed with the receipt request and key announcement an immediate send has.
- **Uninstalling a plugin can now delete its data:** `DELETE /api/system/plugins/:id` takes `{ "purgeData": true }` (also `?purgeData=true`), and the admin Plugins dialog gets an unchecked **Also delete all data this plugin
  stored** box that turns the button into a red **Uninstall and delete data** and asks for the plugin's name. Without the flag nothing changes; with it, only an elevated trusted-role caller is accepted, the request, the actor and
  the plugin are audited (`plugin.purge_requested`, then `plugin.purge_completed` or `plugin.purge_failed`), and the answer says whether a deletion was scheduled. Nothing is deleted while any server still runs the plugin: the
  deletion is recorded when the plugin is uninstalled and runs once every server copy reports the plugin set without it (rolling restart finished, nobody starting), on whichever copy notices first and exactly once (a lease in the
  database), again after a restart. It deletes each collection or table the plugin's model classes use (MongoDB and SQL; recorded when a server loads the plugin, and refused for anything a core model, another plugin or the `acl`
  datastore uses), the plugin's saved settings and this server's leftover package and cached UI builds, after the plugin's optional `onPurge` hook (`./purge` export, 60 s timeout, `AbortPurgeError` stops the purge) - each step
  recorded and repeatable, a failed one retried from the list (`POST /api/system/plugins/purges/:uid/retry`). Adding the plugin again cancels a pending deletion (a warning says so) and is refused while one runs. The Plugins list
  shows "Uninstalled - data will be deleted after servers restart", "Data deleted <date>" or "Data deletion failed: <reason>" with Retry (`GET /api/system/plugins/status` gained `purges`). New `PluginPurgeMongo`/`PluginPurgeSQL`
  models (a `plugin_purge_*` collection/table on the next start, `synchronize` on, no migration). A plugin loaded before this release records what it stores at its first start on it, so one that is disabled until then can't be
  deleted with its data until it has run once. `@rapidmx/booking-plugin` gets an `onPurge` that deletes its profile images from the BlobStore; ActiveSync's three collections and Booking's three are found from their models; MAPI and
  Autodiscover own no data. See the README's "Uninstalling a plugin with its data".
- **Every mailbox has every well-known folder, and the signing-certificate status shows progress (the unreleased `@rapidmx/restapi` changes).** New mailboxes get Inbox, Drafts, Outbox, Sent Items, Deleted Items, Junk
  Email, Archive, Calendar, Contacts, Tasks and Notes when they are created, older ones (and a shared mailbox like `hello@`) get the missing ones the next time their folders are listed - no migration - and every
  folder created is announced live so an open client shows it at once. `GET /api/mail/mailboxes/:id/keyvault/keys/sign-enrollment/:enrollmentId` now reports the stage, a progress percentage, times and, for a
  failure, a code and whether trying again can work; `POST .../:enrollmentId/check` re-checks it on demand (once per ~10 seconds per request) and `GET .../sign-enrollment` finds a mailbox's current request. The
  config files gain `mail:pki:rfc8823:poll_interval_seconds` (300) and `max_pending_hours` (168); nothing needs changing.

## v1.0.0-beta.10

### Features

- **The pages carry the trusted role names (`trustedRoles`, from `trusted_roles`, default `admin`):** the web client's account menu uses them to ask auth-server whether the signed-in user is an administrator - an auth-server token only carries the role once elevated - and shows an "Admin Console" item that only navigates (`/admin` still checks the role and starts the elevation). Needs the next `@rapidmx/web-client`.
- **Static files are sent the way a browser expects:** the browser build (`/assets`, `/fonts`, `/images`, `/styles`, `/favicon.ico`) is
  served by a route of its own with `Content-Type` (with a charset), an `ETag` answered with `304 Not Modified`, `HEAD`, and brotli/gzip.
  `yarn build` now writes `.br` and `.gz` files next to every compressible file (`scripts/precompress-assets.mjs`, 5.6 MiB down to
  1.4 MiB) and the plugin UI build at startup does the same; a file without them is compressed on first request and kept in memory.
  `static_assets:compress`, `static_assets:memory_cache_bytes` and `static_assets:brotli_quality` configure it.
- **Envoy Gateway compresses the API's JSON and the pages' HTML:** the chart attaches a `BackendTrafficPolicy` (brotli, then gzip, from
  1 KiB) to its route. `global.gateway.compression.enabled` is `auto` by default (rendered only when the cluster has Envoy Gateway's
  API), `true` or `false`; it has no effect with `global.gateway.tlsTermination=pod`. The server's own static files already carry
  `Content-Encoding`, which Envoy leaves alone, so nothing is compressed twice.
- **The browser build splits React and the icon set into chunks of their own** (`createServerViteConfig()`'s `codeSplitting` groups `react` and `icons`), on top of the
  web client's own lazy loading: React, React DOM and the scheduler are byte-for-byte the same from one release of the web client to the next, so a returning visitor
  keeps that chunk across deploys (its `Cache-Control` is immutable), and the app's other chunks can change without invalidating it. It replaces one
  1 MB chunk named after an arbitrary module (`MailboxProvisioning-*.js`) and a `client-*.js` holding React DOM and every icon. `strictExecutionOrder` stays on.

### Fixes

- **Live inbox updates, folder-count events and new-mail pop-ups never worked:** `@rapidrest/service-core` creates the publisher every push event goes through
  (`NotificationUtils`) only when a datastore named `notifications` is configured, and none was, so each `sendMessage()` (a delivered message, a changed folder
  count, a delivery-failure notice) silently did nothing, while `/push` kept subscribing on the `events` datastore and the web client waited for events that were
  never sent - new mail needed a page reload. The server now gives `notifications` the same settings as the effective `events` datastore (a deployment's Redis,
  including `datastores__events__*` environment variables) unless a `notifications` datastore is configured explicitly. No chart or values change.
- **The Envoy gateway restarted itself about 40 times a day, and each restart reset every connection** (about 40% of requests failed while it flapped): the
  kubelet probes the `envoy` and `shutdown-manager` containers with a 1 s timeout and kills the pod after three misses, and on a single node whose container
  runtime stalls for a few seconds now and then that is not enough. `single_node_install.sh` (both gateway modes) and `deploy/aws/bootstrap.sh` now give the
  EnvoyProxy an `envoyDeployment` strategic-merge patch with 5 s probe timeouts and 6 allowed failures. To fix an existing host without reinstalling, patch its
  EnvoyProxy (`kubectl -n envoy-gateway-system patch envoyproxy <name> --type merge --patch-file ...`, the same JSON the installers render); Envoy Gateway rolls the pod.

- **Without OpenBao the server and the auth-server didn't share a JWT secret,** so every sign-in was refused: `single_node_install.sh --openbao false` and
  `deploy/aws` (`RAPIDMX_OPENBAO=false`) passed the secret as `global.authSecret`, which no chart reads (the value is `global.jwt.secret`), so each chart generated its own.
  Both now pass `global.jwt.secret`, and so do the chart's notes and the README, which also describes each way to deploy in full.
- **Every page load downloaded the whole web client again (about 2.5 MB):** the bundles were sent with no `Cache-Control`, no validator
  and no compression, so the mail app fetched all ~20 chunks on every folder change and app switch (each one is a full page load).
  Fingerprinted bundles (`/assets/<name>-<hash>.js|css|wasm`) are now `Cache-Control: public, max-age=31536000, immutable` and fetched
  once; a cold inbox load is 0.57 MB with brotli instead of 2.5 MB, and a repeat visit fetches only the page itself. Images and fonts are
  cached for an hour, CSS/JS/HTML that isn't fingerprinted is revalidated (`304`).
- **The local search index's WebAssembly file returned 404:** `.wasm` wasn't a file type the pages' file serving knew, so
  `/assets/wa-sqlite-async-*.wasm` answered with an HTML 404 page. It is served (`application/wasm`, brotli 2.2 MiB to 0.6 MiB).
- **`HEAD` on a static file (`curl -I`) answered 404 with `Content-Length: 9223372036854775808`:** it now answers the real headers and
  length. (`HEAD /` and other pages still do; that is in `@rapidrest/react` and `@rapidrest/service-core`, see `.claude/NOTES.md`.)
- Rate limits audited, no change needed: only the few `@RateLimit()` endpoints (key discovery and lookup, directory and GIF search,
  the booking plugin's public calls) are counted; page loads, `/assets/*`, `/push` and the mail CRUD calls never are.

## v1.0.0-beta.9

## v1.0.0-beta.8

### Fixes

- **Sign-out did not sign out of the auth-server, and sign-in never returned to the mail app:** the chart wrote every allowed
  browser origin twice-quoted (`["\"https://mail.example.com\""]`, a regression from `c80ca7f`), so neither service matched any
  origin - the browser blocked the mail app's cross-origin logout, profile and username calls, and the auth-server dropped
  every `return_to` it was given. Origins are plain again, and `global.corsHosts` now lists `mail.<domain>` and `auth.<domain>`
  by default (the auth-server reads this list too, and it had never contained the mail host). `single_node_install.sh` and
  `deploy/aws/bootstrap.sh` pass the real `--mail-host`/`--auth-host` names as `global.corsHosts`. Needs an auth-server chart
  with the same one-word fix (its `service-config.yaml` had the same bug).
- **Replies to external addresses vanished:** Postfix routed every recipient through postfix-bridge, which handed the message
  back to the server, which dropped it. Fixed in the postfix-bridge chart (`relay_transport` instead of a static
  `transport_maps`); needs that chart's new release, then `helm upgrade`.
- **"No mailbox available" for every account:** `@rapidmx/restapi` asked the auth-server for a user's names at an endpoint that
  doesn't exist. Fixed in `@rapidmx/restapi`.
- Web client fixes shipped with `@rapidmx/react-shared` and `@rapidmx/web-client`: the admin console sends an admin without an
  elevated token to the auth-server's `/auth/elevate` page and back, DNS records have copy buttons, the admin console no longer
  shows the custom header, the account menu shows the profile name (else the username) and an Account link, sender addresses are
  always visible, new mail appears without a refresh, and a failed send shows the mail system's own error.

## v1.0.0-beta.7

## v1.0.0-beta.6

### Fixes

- **`helm lint` failed on a fresh checkout,** and so did CI: the server's URL to the auth-server (`mail__auth_server_url`) read `authserver.host`, which is only set once the auth-server subchart is in `helm/charts/` (its tarballs are git-ignored), and failed with "wrong type for value; expected string; got interface {}" without it. It now falls back to `auth.<global.domain>`, the same default the JWT issuer uses.

## v1.0.0-beta.5

### Features

- **`single_node_install.sh --gateway shared|chart`:** `shared` (the default) has the script create one Gateway,
  `envoy-gateway-system/shared-gateway`, with an HTTPS listener per host that the chart's routes attach to; `chart` has
  the chart create a Gateway for each of its hosts, which the script merges into one Envoy Service for nginx. Both get
  Let's Encrypt certificates through cert-manager, and re-running the script switches between them.
- **A Gateway the chart doesn't create can terminate TLS:** with `global.gateway.name` and `global.gateway.namespace` set,
  the chart's routes attach to every listener of that Gateway that accepts the host, and the chart renders the
  ReferenceGrant that lets it read each `<host>-tls-cert` Secret.
- **The auth-server's e-mail (sign-in and verification codes) is configured:** `global.smtp` (host, port, secure, ignoreTLS,
  requireTLS, from) feeds the auth-server's `smtp_config` and `templates.from.email`. The default is the bundled Postfix
  over the cluster network (host `postfix`, port 25, TLS off for that hop because Postfix's certificate is for its public host
  name), from `noreply@<global.domain>`; the auth-server can only send over SMTP, so on AWS `deploy/aws/bootstrap.sh` points it
  at SES's SMTP endpoint with `RAPIDMX_SES_SMTP_USERNAME`/`RAPIDMX_SES_SMTP_PASSWORD` (kept in a Secret, read through the
  new `authserver.service.extraEnv`) and leaves e-mail unconfigured without them. Needs an auth-server image and chart
  with `nodemailer` and `service.extraEnv`; earlier ones ignore `extraEnv` and fail every send with a missing `nodemailer`.

### Fixes

- **Postfix and postfix-bridge are installed again:** `postfixBridge.create` had been switched off. Postfix's certificate
  comes from the release's own Issuer (`postfixBridge.tls.certManager.issuerName`/`issuerKind` default to it, not to a
  `letsencrypt-prod` ClusterIssuer that only exists where someone made one), and `single_node_install.sh` has it present the
  server's own `<host>-tls-cert` rather than issuing a second certificate for the same name.
- **Nobody could sign in:** the server expected tokens issued by the mail host (`global.jwt.issuer` resolved to `host` in this
  chart) while the auth-server signs them as itself, so every token was refused; both sides use the auth-server's host, as
  in 1.0.0-beta.4. With OpenBao the auth-server also never got its default admin account: External Secrets replaced the whole
  `service-secrets` Secret and dropped `default_accounts`, so it now merges its keys into the Secret the chart renders.
- **The server could not send mail at all:** the chart's `command: ["node"]` replaced the image's entrypoint, which is what writes
  msmtp's config, so `sendmail` failed with "no configuration file available"; the container now gets `args` only, as the chart's own
  comment said.
- **The domain DNS-setup page never found the MX record:** the chart didn't set `mail__dns__mx_hostname`; it defaults to
  `mail.mxHostname` or Postfix's host name.
- **Inbound mail was quarantined:** `service.config` no longer pointed the server at the rspamd and ClamAV Services, so both
  scanners defaulted to localhost, and an unreachable scanner quarantines the message.
- **`service.host` is `host` again** in the places that still read the old name (the sender address of outbound mail and the
  check that Postfix is configured), so a plain `helm install` no longer sends from `mailer@null`.
- **Postfix must run with the postfix-bridge chart that sets `postfix.externalTrafficPolicy: Local`** (released after 1.2.0).
  Behind k3s' ServiceLB every internet client otherwise looks like an internal address, which Postfix trusts, so it relays for
  anyone using one of your domains as the sender. Nothing was relayed while testing, but do not expose port 25 with 1.2.0.
- **deploy/aws** no longer creates a `letsencrypt-prod` ClusterIssuer (the chart issues its certificates from its own Issuer,
  registered with `RAPIDMX_ACME_EMAIL`), passes the chart the values it reads now (`global.gateway.*`, `host`; it still passed
  `gateway.*` and `service.host`, so the chart never used the shared Gateway) and unseals OpenBao with the key as an argument.
- **A domain added in the admin console now works at once,** without restarting Postfix, re-running the installer or upgrading the release: Postfix accepts mail for
  it, lets the server send as it and signs its mail with the DKIM key the console shows (previously the sender allow-list and OpenDKIM's keys were fixed when Postfix started,
  so a new domain could not send, and the first domain signed with a key nobody had published, until Postfix was restarted). Needs the postfix-bridge chart with this change;
  `postfixBridge.domains` / `--mail-domains` is now only the set Postfix knows at start.
- **"mail.trustedAuthservId is empty" after every install, and setting it did nothing:** the value was only read by the install
  warning, never passed to the server (`mail__security__trusted_authserv_id`). It now is, and with the bundled Postfix it defaults
  to Postfix's host name, the authserv-id its OpenDKIM stamps, so no sender is left unverified and the warning appears only when
  there is no bundled Postfix and no id set. This needs the postfix-bridge chart that fixes OpenDKIM's key lookups: before
  it, OpenDKIM could not fetch any DKIM key and never stamped a passing result.
- **cert-manager Issuers were never created,** because `global.certmanager.name` defaulted to `<fullname>-letsencrypt` while
  the chart only created an Issuer named `<fullname>-issuer`; the default is now `-issuer`. The Issuer manifest was
  also mis-indented, so it wouldn't have applied, and `issuerRef` carried a `namespace` cert-manager rejects.
- **The vault-managed secrets were incomplete:** the mail ingest secret and the escrow audit key were missing from the
  ExternalSecrets, so the server pod never started with `global.openbao.enabled`.
- **single_node_install.sh** passed values the chart no longer reads (`gateway.*`), never created a Gateway, waited for
  a port 443 that only exists once the certificates do, and only listened on IPv4 for hosts with AAAA records, which
  Let's Encrypt tries first. Its OpenBao unseal and the unsealer Deployment passed the key as `-`, which OpenBao takes
  literally.

## v1.0.0-beta.4

### Breaking changes

- **`host` is now `service.host`, derived from the new `global.domain`.** Set `global.domain` to the mail domain
  (`example.com`): the server is served at `mail.<domain>`, and Postfix HELOs as that name and sends mail for
  `<domain>`. `service.host` overrides the name itself, and the render fails with a pointer while the old `host` value
  is still set. `authserver.host` still has to be set explicitly (`auth.<domain>`), because the auth-server subchart
  reads its own `host` without rendering templates.
- **JWT audience and issuer are now the domain and the auth-server host** (previously `mail-server-api` on both sides),
  so everyone signs in again after this upgrade - existing tokens no longer verify.
- **`global.mailIngestSecret` replaces `mail.ingestSecret` as the required secret.** It's shared by the server and the
  bundled postfix-bridge; `mail.ingestSecret` now defaults to it. An install that only sets `mail.ingestSecret` fails to
  render until `global.mailIngestSecret` is set to the same value.
- **Postfix and postfix-bridge are installed with the chart** (the `postfixBridge` dependency, postfix-bridge 1.1.0). A
  release that installed the postfix-bridge chart separately gets a second Postfix: uninstall that release, or set
  `postfixBridge.create=false`.

### Features

- **OpenBao as the secret vault** (`global.openbao.enabled`, off in the chart, on in the install scripts): the JWT, cookie, session, escrow audit and
  ingest secrets live in OpenBao, along with the certificate authority for end-to-end encrypted mail
  (`mail:pki:backend=openbao`, a PKI mount and an issuing role), and External Secrets copies the values into the
  Kubernetes Secrets the pods load, so no application change was needed. The bundled auth-server reads the same vault
  path (`global.openbao`), so both ends share one JWT secret and neither `global.authSecret` nor
  `global.mailIngestSecret` has to be supplied. **OpenBao and External Secrets are prerequisites, like cert-manager -
  the chart installs neither.** `single_node_install.sh --openbao true` and `deploy/aws` (`RAPIDMX_OPENBAO`, the
  `EnableOpenBao` stack parameter) install and initialise the vault, keep its unseal key in a Secret with an unsealer
  Deployment that re-unseals it after any restart, write each secret once (upgrades never re-key them), set up the PKI
  mount and role, and create the tokens the chart reads. Point `global.openbao.address` at a vault you already run to
  use that one instead - with `global.openbao.auth.method=kubernetes` it authenticates with the pod's ServiceAccount and
  stores no token. The chart itself defaults the value to false, so a `helm install` that doesn't opt in behaves exactly
  as before.
- **AWS deployments:** `mail.transport.provider=ses` sends outbound mail through AWS SES (`SesMailTransport`, region
  from `mail.transport.ses.region`) instead of Postfix, for a deployment receiving through
  [`ses-bridge`](https://github.com/rapidmx/ses-bridge); the render refuses SES together with the bundled Postfix.
  `serviceAccount.create` with an `eks.amazonaws.com/role-arn` annotation gives the pod an AWS role (IRSA), and
  `mail.ingestService.enabled` adds an internal load balancer for `/internal/mta` so ses-bridge's Lambda can reach it
  from inside the VPC (the public Gateway still answers 404 there), restricted with
  `mail.ingestService.loadBalancerSourceRanges`.
- **AWS deployment in `deploy/aws/`:** a CloudFormation template (network, IAM role, security group, EC2 instance,
  optional Route 53 records) whose user data runs `bootstrap.sh`: k3s with the AWS cloud controller and EBS CSI driver,
  Envoy Gateway behind a Classic Load Balancer that forwards TCP with the PROXY protocol, cert-manager, and this chart
  with SES for mail. `single_node_install.sh` stays the bare-metal installer.
- **Bundled mail transport:** with a public `host`, set `postfixBridge.hostname` (Postfix's MX host name) and
  `postfixBridge.domains` (the domains it sends mail for); the render fails while they're still the placeholders.
  Postfix signs with the DKIM keys the server writes to its `mail.dkim.storage` volume, so with `ReadWriteOnce` storage
  both pods run on the same node. Without cert-manager, `postfixBridge.tls.certManager.enabled=false` self-signs
  Postfix's certificate.
- **single_node_install.sh** installs Postfix too: `--mail-domains` sets the domains it sends mail for (default
  `--domain`), port 25 is opened in ufw or firewalld, and `--tls false` works with a public domain (Postfix gets a
  self-signed certificate).

### Fixes

- **Helm values comments:** the 1.0.0-beta.3 release tool stripped every comment from `helm/values.yaml`; they're back.
- **README:** the compose section's loopback address read `1.0.0-beta.3.1` instead of `127.0.0.1`.

## v1.0.0-beta.3

A reference implementation of a RapidMX mail server, providing a complete, deployable mail service that includes a web mail (React) client as well as Exchange ActiveSync, and MAPI support.
