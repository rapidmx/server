///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { DnsMxRecord, DnsResolver } from "@rapidmx/restapi";
const { Config } = ObjectDecorators;

const TXT_TYPE = 16;
const MX_TYPE = 15;

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

/** Parses a DoH JSON MX answer's `data` field (`"<priority> <exchange>"`, unquoted) into the same shape
 * `NodeDnsResolver` returns - `exchange` without the trailing root dot DoH responses include. */
function parseMxRecord(data: string): DnsMxRecord {
    const spaceIndex = data.indexOf(" ");
    const priority = Number.parseInt(data.slice(0, spaceIndex), 10);
    const exchange = data.slice(spaceIndex + 1).replace(/\.$/, "");
    return { priority, exchange };
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
