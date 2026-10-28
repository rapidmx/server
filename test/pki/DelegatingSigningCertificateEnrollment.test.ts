///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
// The signing-certificate enrollment the server registers (spec 11.3): the backend (manual, RFC 8823, or none) is chosen from the integrations layer when an
// enrollment starts, and an enrollment already in flight stays with the backend that started it.
import { HostConfig, SIGNING_ENROLLMENT_UNKNOWN } from "@rapidmx/restapi";
import { DelegatingSigningCertificateEnrollment, type SigningBackendKey } from "../../src/pki/DelegatingSigningCertificateEnrollment.js";
import { IntegrationsLayer } from "../../src/integrations/IntegrationsLayer.js";
import { keyringCipher, layeredConfig, logger, settingsRow } from "../helpers/integrations.js";

/** What the real backends do with an enrollment id, reduced to what the delegation needs. */
class FakeBackend {
    public readonly enrollments: Map<string, "pending" | "issued"> = new Map();
    public next = 1;

    constructor(
        public readonly kind: "manual" | "rfc8823" | "none",
        public readonly key: string,
    ) {}

    get name(): string {
        return this.kind === "none" ? "null" : this.kind;
    }

    async describeBackend() {
        return { backend: this.kind, automatic: this.kind === "rfc8823", adminUpload: this.kind === "manual", key: this.key };
    }

    async startEnrollment(): Promise<{ enrollmentId: string }> {
        if (this.kind === "none") {
            throw Object.assign(new Error("Signing certificate enrollment is not available for this deployment."), { status: 500 });
        }
        const enrollmentId = `${this.kind}-${this.next++}`;
        this.enrollments.set(enrollmentId, "pending");
        return { enrollmentId };
    }

    private require(id: string): void {
        if (!this.enrollments.has(id)) {
            throw Object.assign(new Error(`No enrollment found with id '${id}'.`), { code: SIGNING_ENROLLMENT_UNKNOWN, status: 404 });
        }
    }

    async checkStatus(id: string) {
        this.require(id);
        return { status: this.enrollments.get(id)! };
    }

    async describeEnrollment(id: string) {
        this.require(id);
        return { identity: "user@example.com" };
    }

    async cancelEnrollment(id: string, reason: string) {
        this.require(id);
        this.enrollments.delete(id);
        return void reason;
    }

    async listPendingEnrollments() {
        return [...this.enrollments].map(([enrollmentId, status]) => ({ enrollmentId, identity: "user@example.com", status, hasWrappedKey: true }));
    }

    async advanceEnrollment(id: string) {
        this.require(id);
        return true;
    }

    async describeProgress(id: string) {
        this.require(id);
        return { provider: this.kind, status: this.enrollments.get(id)! };
    }

    async listEnrollments() {
        return [...this.enrollments].map(([enrollmentId, status]) => ({ enrollmentId, identity: "user@example.com", status, createdAt: "2026-10-28T00:00:00Z" }));
    }
}

class RfcOnly extends FakeBackend {
    public health = { ok: true };
    // Only an automatic backend has something to poll.
    async checkNow(id: string) {
        this.require(id);
        return { provider: "rfc8823", status: "polled" };
    }
    async findPendingEnrollmentId() {
        return "rfc8823-1";
    }
}

/** The delegating enrollment with its backends replaced by the doubles above. */
class TestDelegate extends DelegatingSigningCertificateEnrollment {
    public built: SigningBackendKey[] = [];
    public failBuilding?: Error;
    public buildAttempts = 0;

    protected async createBackend(key: SigningBackendKey): Promise<any> {
        this.buildAttempts++;
        if (this.failBuilding) {
            throw this.failBuilding;
        }
        this.built.push(key);
        return key.kind === "rfc8823" ? new RfcOnly("rfc8823", JSON.stringify(key)) : new FakeBackend(key.kind, JSON.stringify(key));
    }
}

describe("DelegatingSigningCertificateEnrollment", () => {
    let conf: ReturnType<typeof layeredConfig>;
    let layer: IntegrationsLayer;
    let cipher: Awaited<ReturnType<typeof keyringCipher>>["cipher"];
    let uninstall: (() => void) | undefined;
    let version = 0;

    const choose = (signingCa: Record<string, string>) => layer.apply(settingsRow(cipher, { version: ++version, signingCa }));
    let log: ReturnType<typeof logger>;
    const make = async (): Promise<any> => {
        const delegate: any = new TestDelegate();
        delegate.logger = log;
        delegate.configuredBackend = conf.get("mail:pki:signing_enrollment:backend");
        delegate.configuredDirectoryUrl = conf.get("mail:pki:rfc8823:directory_url");
        delegate.configuredContactEmail = conf.get("mail:pki:rfc8823:contact_email");
        await delegate.init();
        return delegate;
    };

    beforeEach(async () => {
        version = 0;
        conf = layeredConfig({ mail: { pki: { signing_enrollment: { backend: "manual" } } } });
        ({ cipher } = await keyringCipher(conf));
        log = logger();
        layer = new IntegrationsLayer(conf, cipher, log);
        uninstall = HostConfig.install(conf);
    });

    afterEach(() => uninstall?.());

    it("starts enrollments with the deployment's backend until the administrator chooses another", async () => {
        const delegate = await make();
        expect(delegate.kind).toBe("manual");
        expect(delegate.name).toBe("manual");
        expect(await delegate.startEnrollment("a@example.com", "csr")).toEqual({ enrollmentId: "manual-1" });
        expect((await delegate.describeBackend()).backend).toBe("manual");
    });

    it("moves to the backend the administrator chose at the next enrollment, without a restart, and back when it is reset", async () => {
        const delegate = await make();
        choose({ backend: "rfc8823" });
        expect((await delegate.startEnrollment()).enrollmentId).toBe("rfc8823-1");
        expect(delegate.kind).toBe("rfc8823");
        expect((await delegate.describeBackend()).backend).toBe("rfc8823");

        layer.apply(undefined);
        // The manual backend built at the start serves it, with the enrollments it already had.
        expect((await delegate.startEnrollment()).enrollmentId).toBe("manual-1");
        expect(delegate.kind).toBe("manual");
        // The backends are built once each.
        expect(delegate.built.map((key: SigningBackendKey) => key.kind)).toEqual(["manual", "rfc8823"]);
    });

    it("turns enrollment off with the backend none: nothing is started, and the info says so", async () => {
        const delegate = await make();
        choose({ backend: "none" });
        await expect(delegate.startEnrollment()).rejects.toThrow(/not available/);
        expect(delegate.kind).toBe("none");
        expect((await delegate.describeBackend()).backend).toBe("none");
    });

    it("keeps an enrollment in flight with the backend that started it, whatever is chosen after", async () => {
        const delegate = await make();
        const { enrollmentId: manualId } = await delegate.startEnrollment();
        choose({ backend: "rfc8823" });
        const { enrollmentId: rfcId } = await delegate.startEnrollment();

        expect(await delegate.checkStatus(manualId)).toEqual({ status: "pending" });
        expect(await delegate.checkStatus(rfcId)).toEqual({ status: "pending" });
        expect(await delegate.describeEnrollment(manualId)).toEqual({ identity: "user@example.com" });
        expect(await delegate.advanceEnrollment(manualId)).toBe(true);

        await delegate.cancelEnrollment(manualId, "no longer needed");
        await expect(delegate.checkStatus(manualId)).rejects.toMatchObject({ code: SIGNING_ENROLLMENT_UNKNOWN });
        expect(await delegate.checkStatus(rfcId)).toEqual({ status: "pending" });
    });

    it("answers an id no backend knows with the active backend's own error, so a client clears the stale id", async () => {
        const delegate = await make();
        choose({ backend: "rfc8823" });
        await delegate.startEnrollment();
        await expect(delegate.checkStatus("left-over")).rejects.toMatchObject({ code: SIGNING_ENROLLMENT_UNKNOWN, status: 404 });
        await expect(delegate.describeEnrollment("left-over")).rejects.toMatchObject({ code: SIGNING_ENROLLMENT_UNKNOWN });
    });

    it("lists the enrollments of every backend it has used, so the driver job still finishes those in flight after a switch to none", async () => {
        const delegate = await make();
        choose({ backend: "rfc8823" });
        const { enrollmentId } = await delegate.startEnrollment();
        choose({ backend: "none" });

        expect((await delegate.listPendingEnrollments()).map((entry: any) => entry.enrollmentId)).toEqual([enrollmentId]);
        expect((await delegate.listEnrollments()).map((entry: any) => entry.enrollmentId)).toEqual([enrollmentId]);
        expect(await delegate.advanceEnrollment(enrollmentId)).toBe(true);
    });

    it("builds a new RFC 8823 backend for another CA directory or contact, and the one before still serves its enrollments", async () => {
        const delegate = await make();
        choose({ backend: "rfc8823", directoryUrl: "https://ca.one.example/acme", contactEmail: "ops@example.com" });
        const { enrollmentId: first } = await delegate.startEnrollment();
        choose({ backend: "rfc8823", directoryUrl: "https://ca.two.example/acme", contactEmail: "ops@example.com" });
        const { enrollmentId: second } = await delegate.startEnrollment();

        const keys: SigningBackendKey[] = delegate.built;
        expect(keys.map((key) => [key.kind, key.directoryUrl])).toEqual([
            ["manual", undefined],
            ["rfc8823", "https://ca.one.example/acme"],
            ["rfc8823", "https://ca.two.example/acme"],
        ]);
        expect(first).toBe("rfc8823-1");
        expect(second).toBe("rfc8823-1");
        // Both backends know "rfc8823-1" (they are separate doubles): the active one answers it.
        expect(await delegate.checkStatus(second)).toEqual({ status: "pending" });
        // The same choice again builds nothing.
        choose({ backend: "rfc8823", directoryUrl: "https://ca.two.example/acme", contactEmail: "ops@example.com" });
        await delegate.startEnrollment();
        expect(delegate.built).toHaveLength(3);
    });

    it("shows a member only a backend it can use has, as the callers that check for one need", async () => {
        const delegate = await make();
        expect(typeof delegate.listPendingEnrollments).toBe("function");
        expect(delegate.findPendingEnrollmentId).toBeUndefined();
        expect(delegate.health).toBeUndefined();

        choose({ backend: "rfc8823" });
        await delegate.startEnrollment();
        expect(typeof delegate.findPendingEnrollmentId).toBe("function");
        expect(await delegate.findPendingEnrollmentId()).toBe("rfc8823-1");
        expect(delegate.health).toEqual({ ok: true });

        // Still reachable after a switch away, since an enrollment of that backend may still be waiting for its challenge.
        choose({ backend: "none" });
        await delegate.startEnrollment().catch(() => undefined);
        expect(typeof delegate.findPendingEnrollmentId).toBe("function");
    });

    it("can be awaited and inspected like any object", async () => {
        const delegate = await make();
        expect(await Promise.resolve(delegate)).toBe(delegate);
        expect(delegate.then).toBeUndefined();
        expect(String(Object.prototype.toString.call(delegate))).toBe("[object Object]");
    });

    it("keeps the backend it has when the new one can't be built, and tries again at the next enrollment", async () => {
        const delegate = await make();
        delegate.failBuilding = new Error("cannot reach the CA");
        choose({ backend: "rfc8823" });
        await expect(delegate.startEnrollment()).rejects.toThrow(/cannot reach the CA/);
        expect(delegate.kind).toBe("manual");

        delegate.failBuilding = undefined;
        expect((await delegate.startEnrollment()).enrollmentId).toBe("rfc8823-1");
    });

    it("keeps an enrollment of the manual backend on it for the check-now call after a switch to RFC 8823, answering with its progress as restapi's callers do without checkNow", async () => {
        const delegate = await make();
        const { enrollmentId: manualId } = await delegate.startEnrollment();
        choose({ backend: "rfc8823" });
        const { enrollmentId: rfcId } = await delegate.startEnrollment();

        // The member exists on the delegation (the RFC 8823 backend has it), but the manual enrollment is not asked of that backend, which would not know it.
        expect(typeof delegate.checkNow).toBe("function");
        expect(await delegate.checkNow(manualId)).toEqual({ provider: "manual", status: "pending" });
        expect(await delegate.checkNow(rfcId)).toEqual({ provider: "rfc8823", status: "polled" });
        // An id nobody knows gets the answer of the backend in force, so a client clears it.
        await expect(delegate.checkNow("left-over")).rejects.toMatchObject({ code: SIGNING_ENROLLMENT_UNKNOWN });
    });

    it("does not send a call to a backend that does not know the enrollment when its own backend lacks the member", async () => {
        const delegate = await make();
        const { enrollmentId: manualId } = await delegate.startEnrollment();
        choose({ backend: "rfc8823" });
        await delegate.startEnrollment();
        // Only the RFC 8823 double has a challenge correlation; the manual enrollment's backend does not.
        delegate.backends.get(JSON.stringify({ kind: "rfc8823" })).recordChallengeToken = async () => "recorded";
        await expect(delegate.recordChallengeToken(manualId, "token")).rejects.toThrow(/does not support recordChallengeToken/);
    });

    it("keeps serving every other call with the backend it has when the new one can't be built, and only the start of an enrollment fails", async () => {
        const delegate = await make();
        const { enrollmentId: manualId } = await delegate.startEnrollment();
        delegate.failBuilding = new Error("cannot reach the CA");
        choose({ backend: "rfc8823" });

        // The in-flight enrollment, the listings the driver job relies on and the info all go on.
        expect(await delegate.checkStatus(manualId)).toEqual({ status: "pending" });
        expect((await delegate.listPendingEnrollments()).map((entry: any) => entry.enrollmentId)).toEqual([manualId]);
        expect((await delegate.listEnrollments()).map((entry: any) => entry.enrollmentId)).toEqual([manualId]);
        expect((await delegate.describeBackend()).backend).toBe("manual");
        expect(await delegate.advanceEnrollment(manualId)).toBe(true);
        // The failure is said once, and the build is not tried again on every call.
        expect(log.warn.mock.calls.filter((call) => String(call[0]).includes("cannot reach the CA"))).toHaveLength(1);
        expect(delegate.buildAttempts).toBe(2);

        // Starting an enrollment is what the new backend is for: that fails with the error, every time.
        await expect(delegate.startEnrollment()).rejects.toThrow(/cannot reach the CA/);
        await expect(delegate.startEnrollment()).rejects.toThrow(/cannot reach the CA/);
        expect(delegate.buildAttempts).toBe(4);

        // Once the build can succeed, the very next start does it.
        delegate.failBuilding = undefined;
        expect((await delegate.startEnrollment()).enrollmentId).toBe("rfc8823-1");
        expect(delegate.kind).toBe("rfc8823");
    });

    it("tries a backend that failed to build again for the other calls once the retry period has passed", async () => {
        const delegate = await make();
        delegate.retryAfterMs = 20;
        delegate.failBuilding = new Error("cannot reach the CA");
        choose({ backend: "rfc8823" });
        await delegate.listEnrollments();
        delegate.failBuilding = undefined;
        await delegate.listEnrollments();
        expect(delegate.kind).toBe("manual");
        await new Promise((resolve) => setTimeout(resolve, 40));
        await delegate.listEnrollments();
        expect(delegate.kind).toBe("rfc8823");
    });

    it("names the backend the configuration holds now in kind and name once it is built, not the one of the last enrollment call", async () => {
        const delegate = await make();
        choose({ backend: "rfc8823" });
        await delegate.startEnrollment();
        choose({ backend: "manual" });
        // Built at the start, so it is known now without a call that would switch.
        expect(delegate.kind).toBe("manual");
        expect(delegate.name).toBe("manual");
    });

    it("reads the deployment's own configuration when the server has installed none (a process with no host)", async () => {
        uninstall?.();
        uninstall = undefined;
        const delegate: any = new TestDelegate();
        delegate.configuredBackend = "rfc8823";
        delegate.configuredDirectoryUrl = "https://ca.example/acme";
        await delegate.init();
        expect((await delegate.startEnrollment()).enrollmentId).toBe("rfc8823-1");
        expect(delegate.built[0]).toMatchObject({ kind: "rfc8823", directoryUrl: "https://ca.example/acme" });
    });

    it("reads a backend it doesn't know as the manual flow, as the shipped configuration always has", async () => {
        conf.set("mail:pki:signing_enrollment:backend", "something-else");
        const delegate = await make();
        expect(delegate.kind).toBe("manual");
    });
});

describe("DelegatingSigningCertificateEnrollment built by the ObjectFactory", () => {
    it("is injected as the enrollment, builds the real backends, and follows the integrations layer", async () => {
        const conf = layeredConfig({ mail: { pki: { signing_enrollment: { backend: "manual" }, manual_enrollment: { store_path: "./data/test-manual-enrollments.json" } } } });
        const { cipher, factory } = await keyringCipher(conf);
        const layer = new IntegrationsLayer(conf, cipher, logger());
        const uninstall = HostConfig.install(conf);
        try {
            factory.register(DelegatingSigningCertificateEnrollment, "SigningCertificateEnrollment");
            const enrollment: any = await factory.newInstance("SigningCertificateEnrollment", { name: "default" });
            // The same instance for every injection, with the backend in force known from the start.
            expect(await factory.newInstance("SigningCertificateEnrollment", { name: "default" })).toBe(enrollment);
            expect(enrollment.kind).toBe("manual");
            expect(enrollment.name).toBe("manual");
            expect(await enrollment.describeBackend()).toEqual({ backend: "manual", automatic: false, adminUpload: true });
            expect(typeof enrollment.getRequest).toBe("function");

            layer.apply(settingsRow(cipher, { version: 1, signingCa: { backend: "none" } }));
            expect(await enrollment.describeBackend()).toEqual({ backend: "none", automatic: false, adminUpload: false });
            expect(enrollment.kind).toBe("none");
            await expect(enrollment.startEnrollment("a@example.com", "csr")).rejects.toThrow(/not available/);
            // The manual backend is still there for what it started: its members stay reachable, and it lists nothing.
            expect(await enrollment.listEnrollments()).toEqual([]);
        } finally {
            uninstall();
            await factory.destroy();
        }
    });
});
