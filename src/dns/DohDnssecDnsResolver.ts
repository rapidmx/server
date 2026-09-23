///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { DnsMxRecord, DnsResolver, DnsSrvRecord } from "@rapidmx/restapi";
const { Config } = ObjectDecorators;

const TXT_TYPE = 16;
const MX_TYPE = 15;
const CNAME_TYPE = 5;
const SRV_TYPE = 33;

interface DohAnswer {
    name: string;
    type: number;
    TTL: number;
    data: string;
}

interface DohResponse {
    Status: number;
    AD?: boolean;
    Answer?: DohAnswer[];
}

/** Splits a DoH JSON TXT answer's `data` field - one or more double-quoted, backslash-escaped chunks
 * separated by a space, e.g. `"chunk one" "chunk two"` - back into the same `string[]` shape Node's own
 * `dns.promises.resolveTxt()` (and `NodeDnsResolver`) produce per record. Falls back to treating the
 * whole value as a single chunk if it doesn't look quoted at all (a resolver deviating from the
 * convention shouldn't make this throw - `specs/end-to-end_encryption.md`'s DNSSEC requirement is about
 * validating what's *in* the record, not about being strict on formatting quirks). */
function parseTxtChunks(data: string): string[] {
    const chunks: string[] = [];
    const pattern = /"((?:[^"\\]|\\.)*)"/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(data)) !== null) {
        chunks.push(match[1].replace(/\\(.)/g, "$1"));
    }
    return chunks.length > 0 ? chunks : [data];
}

/** A non-negative integer field of a parsed record, or `undefined` when `raw` isn't one (missing, non-numeric,
 * fractional or negative) - `Number.parseInt()` alone would silently turn any of those into `NaN` instead of
 * refusing the record, and a `NaN` priority/weight/port then propagates into whatever sorts or compares it (e.g. a
 * distribution list's or Autodiscover's own MX/SRV preference logic) with no clear error pointing at the resolver
 * response that caused it. */
function parsedNonNegativeInt(raw: string | undefined): number | undefined {
    if (raw === undefined || raw === "") {
        return undefined;
    }
    const value: number = Number(raw);
    return Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** Parses a DoH JSON MX answer's `data` field (`"<priority> <exchange>"`, unquoted) into the same shape
 * `NodeDnsResolver` returns - `exchange` without the trailing root dot DoH responses include.
 * @throws when `data` isn't `"<non-negative integer priority> <exchange>"` - a malformed or tampered-with answer is
 * refused outright rather than silently producing a `NaN` priority (see `parsedNonNegativeInt()`). */
function parseMxRecord(data: string): DnsMxRecord {
    const spaceIndex = data.indexOf(" ");
    const priority: number | undefined = spaceIndex >= 0 ? parsedNonNegativeInt(data.slice(0, spaceIndex)) : undefined;
    const exchange: string = spaceIndex >= 0 ? data.slice(spaceIndex + 1).replace(/\.$/, "") : "";
    if (priority === undefined || !exchange) {
        throw new Error(`Malformed MX record data: "${data}"`);
    }
    return { priority, exchange };
}

/** Parses a DoH JSON SRV answer's `data` field (`"<priority> <weight> <port> <target>"`, unquoted) into
 * the same shape `NodeDnsResolver` returns - `target` without the trailing root dot DoH responses include.
 * @throws when `data` isn't `"<non-negative integer priority> <non-negative integer weight> <port 0-65535> <target>"`
 * - a malformed or tampered-with answer is refused outright rather than silently producing `NaN` fields (see
 * `parsedNonNegativeInt()`). */
function parseSrvRecord(data: string): DnsSrvRecord {
    const [priorityRaw, weightRaw, portRaw, target] = data.split(" ");
    const priority: number | undefined = parsedNonNegativeInt(priorityRaw);
    const weight: number | undefined = parsedNonNegativeInt(weightRaw);
    const port: number | undefined = parsedNonNegativeInt(portRaw);
    if (priority === undefined || weight === undefined || port === undefined || port > 65535 || !target) {
        throw new Error(`Malformed SRV record data: "${data}"`);
    }
    return { priority, weight, port, target: target.replace(/\.$/, "") };
}

/**
 * A `DnsResolver` that validates DNSSEC on every lookup, per `specs/end-to-end_encryption.md`'s
 * Transport Trust requirement ("Requesting servers SHOULD validate DNSSEC on the TXT lookup where
 * available") - real DNSSEC validation needs a validating resolver in the query path, which Node's
 * built-in `dns` module (and therefore `NodeDnsResolver`) does not provide.
 *
 * Rather than embedding a full DNSSEC validator (a large undertaking with real cryptographic risk if
 * done wrong), this delegates validation to a trusted upstream DoH resolver (Cloudflare's by default)
 * over TLS - the same trust model Autocrypt-style discovery already relies on for the HTTPS discovery
 * endpoint itself - and reads back the response's `AD` (Authenticated Data) flag, which a validating
 * resolver sets only when every RRSIG in the chain checked out. TLS on the DoH query itself is what
 * makes this trustworthy (a plain UDP/TCP query to a validating resolver could be tampered with
 * in-flight after validation happened but before it reached this process).
 *
 * **Fails closed by default** (`requireAd: true`, mirroring `mail:security:trusted_authserv_id`'s own
 * empty-default fail-closed convention elsewhere in this codebase): a domain that fails DNSSEC
 * validation, or one whose zone isn't signed at all, throws exactly like a resolution failure would.
 * An admin who needs to interoperate with unsigned zones can set `mail:dns:doh:require_ad` to `false`
 * to downgrade this to "validate when possible, otherwise proceed" - an explicit, informed choice
 * rather than this module's own default.
 *
 * @author Jean-Philippe Steinmetz
 */
export class DohDnssecDnsResolver implements DnsResolver {
    @Config("mail:dns:doh:endpoint", "https://cloudflare-dns.com/dns-query")
    private endpoint: string = "https://cloudflare-dns.com/dns-query";

    @Config("mail:dns:doh:require_ad", true)
    private requireAd: boolean = true;

    @Config("mail:dns:doh:timeout_ms", 5_000)
    private timeoutMs: number = 5_000;

    public async resolveTxt(hostname: string): Promise<string[][]> {
        const answers = await this.query(hostname, TXT_TYPE);
        return answers.map((answer) => parseTxtChunks(answer.data));
    }

    public async resolveMx(hostname: string): Promise<DnsMxRecord[]> {
        const answers = await this.query(hostname, MX_TYPE);
        return answers.map((answer) => parseMxRecord(answer.data));
    }

    public async resolveCname(hostname: string): Promise<string[]> {
        const answers = await this.query(hostname, CNAME_TYPE);
        return answers.map((answer) => answer.data.replace(/\.$/, ""));
    }

    public async resolveSrv(hostname: string): Promise<DnsSrvRecord[]> {
        const answers = await this.query(hostname, SRV_TYPE);
        return answers.map((answer) => parseSrvRecord(answer.data));
    }

    private async query(hostname: string, type: number): Promise<DohAnswer[]> {
        const url = `${this.endpoint}?name=${encodeURIComponent(hostname)}&type=${type}`;
        const response = await fetch(url, {
            headers: { accept: "application/dns-json" },
            signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response.ok) {
            throw new Error(`DoH query for ${hostname} failed: HTTP ${response.status}`);
        }
        const body = (await response.json()) as DohResponse;
        if (body.Status !== 0) {
            throw new Error(`DoH query for ${hostname} failed: DNS response status ${body.Status}`);
        }
        if (this.requireAd && !body.AD) {
            throw new Error(`DoH query for ${hostname} failed: DNSSEC validation was not confirmed (AD flag not set)`);
        }
        const answers = (body.Answer ?? []).filter((answer) => answer.type === type);
        if (answers.length === 0) {
            throw new Error(`DoH query for ${hostname} returned no records of type ${type}`);
        }
        return answers;
    }
}
