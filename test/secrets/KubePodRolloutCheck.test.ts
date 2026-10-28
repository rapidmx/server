///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { resolveServerRolloutCheck } from "@rapidmx/restapi";
import { KubePodRolloutCheck } from "../../src/secrets/KubePodRolloutCheck.js";
import { FakeKubernetes } from "./fakeKubernetes.js";

const SELECTOR = "app.kubernetes.io/instance=rel,app.kubernetes.io/component=server";
const SERVER = { "app.kubernetes.io/instance": "rel", "app.kubernetes.io/component": "server" };
const ENV = { KUBERNETES_SERVICE_HOST: "10.43.0.1", HOSTNAME: "rel-server-new-1" };

describe("KubePodRolloutCheck", () => {
    let kube: FakeKubernetes;

    async function check(overrides: Partial<ConstructorParameters<typeof KubePodRolloutCheck>[0]> = {}) {
        return new KubePodRolloutCheck({ selector: SELECTOR, kube: await kube.client(), env: ENV, ...overrides }).check();
    }

    beforeEach(() => {
        kube = new FakeKubernetes();
        kube.pods = [
            { name: "rel-server-new-1", labels: { ...SERVER, "pod-template-hash": "new" } },
            { name: "rel-server-new-2", labels: { ...SERVER, "pod-template-hash": "new" } },
            { name: "rel-clamav-0", labels: { "app.kubernetes.io/instance": "rel", "app.kubernetes.io/component": "clamav", "pod-template-hash": "old" } },
        ];
    });

    it("is rolled out when every pod of the server Deployment carries this pod's template hash", async () => {
        expect(await check()).toEqual({ rolledOut: true });
        const paths = kube.requests.map((request) => request.url.pathname + request.url.search);
        expect(paths).toEqual([
            "/api/v1/namespaces/mail/pods/rel-server-new-1",
            `/api/v1/namespaces/mail/pods?labelSelector=${encodeURIComponent(SELECTOR)}`,
        ]);
        // Read-only, and only pods.
        expect(kube.requests.every((request) => (request.method ?? "GET") === "GET")).toBe(true);
    });

    it("is not rolled out while a pod of an older ReplicaSet is left, naming it", async () => {
        kube.pods.push({ name: "rel-server-old-1", labels: { ...SERVER, "pod-template-hash": "old" } });
        const status = await check();
        expect(status.rolledOut).toBe(false);
        expect(status.reason).toMatch(/rel-server-old-1/);
        expect(status.reason).not.toMatch(/rel-server-new/);
    });

    it("counts a terminating pod of the old release, which still runs the old code", async () => {
        kube.pods.push({ name: "rel-server-old-2", labels: { ...SERVER, "pod-template-hash": "old" }, terminating: true });
        const status = await check();
        expect(status.rolledOut).toBe(false);
        expect(status.reason).toMatch(/rel-server-old-2/);
    });

    it("counts a pod with no template hash as older", async () => {
        kube.pods.push({ name: "rel-server-bare", labels: SERVER });
        expect((await check()).reason).toMatch(/rel-server-bare/);
    });

    it("does not wait for a pod that has finished running, such as an evicted old one", async () => {
        kube.pods.push(
            { name: "rel-server-evicted", labels: { ...SERVER, "pod-template-hash": "old" }, phase: "Failed" },
            { name: "rel-server-done", labels: { ...SERVER, "pod-template-hash": "old" }, phase: "Succeeded" },
        );
        expect(await check()).toEqual({ rolledOut: true });
    });

    it("names at most a few old pods, with how many more there are", async () => {
        for (let i = 0; i < 15; i++) {
            kube.pods.push({ name: `rel-server-old-${i}`, labels: { ...SERVER, "pod-template-hash": "old" } });
        }
        const status = await check();
        expect(status.rolledOut).toBe(false);
        expect(status.reason).toMatch(/and 5 more/);
        expect(status.reason!.length).toBeLessThan(500);
    });

    it("can't tell, and rejects so the encryptor waits, when the pods can't be listed or its own can't be read", async () => {
        kube.failWith = 403;
        await expect(check()).rejects.toThrow(/HTTP 403/);
        kube.failWith = undefined;
        await expect(check({ env: { ...ENV, HOSTNAME: "no-such-pod" } })).rejects.toThrow(/HTTP 404/);
        await expect(check({ env: { KUBERNETES_SERVICE_HOST: "10.43.0.1" } })).rejects.toThrow(/HOSTNAME/);
    });

    it("can't tell without the selector the chart renders, or when its own pod has no template hash", async () => {
        await expect(check({ selector: "" })).rejects.toThrow(/pod_selector isn't set/);
        kube.pods[0].labels = SERVER;
        await expect(check()).rejects.toThrow(/pod-template-hash/);
    });

    it("is rolled out outside Kubernetes, where there is no rolling upgrade, and can't tell in a pod without a token", async () => {
        const outside = new KubePodRolloutCheck({ selector: "", env: {} });
        expect(await outside.check()).toEqual({ rolledOut: true });
        const noToken = new KubePodRolloutCheck({ selector: SELECTOR, env: ENV, serviceAccountDir: "/nonexistent/serviceaccount" });
        await expect(noToken.check()).rejects.toThrow(/no service account token/);
    });

    it("is what a Kubernetes server registers under ServerRolloutCheck, found by restapi's resolver", async () => {
        const factory = { newInstance: async () => new KubePodRolloutCheck({ selector: SELECTOR, kube: await kube.client(), env: ENV }) };
        const resolved = await resolveServerRolloutCheck(factory, undefined, ENV);
        expect(await resolved.check()).toEqual({ rolledOut: true });
    });
});
