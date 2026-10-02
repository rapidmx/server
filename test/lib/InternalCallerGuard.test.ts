///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { InternalCallerGuard, guardInternalCaller } from "../../src/lib/InternalCallerGuard.js";

const request = (headers: Record<string, string> = {}, address: string = "10.0.0.5"): any => ({ headers, socket: { remoteAddress: address } });

describe("InternalCallerGuard", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("lets a direct, in-cluster request through", () => {
        expect(() => new InternalCallerGuard().check(request({ authorization: "Bearer x" }))).not.toThrow();
    });

    it("answers 404 to a request that came through a proxy, whatever it presents", () => {
        const guard = new InternalCallerGuard();
        for (const header of ["x-forwarded-for", "x-real-ip", "forwarded", "x-forwarded-host"]) {
            expect(() => guard.check(request({ [header]: "203.0.113.9" }))).toThrow(expect.objectContaining({ status: 404 }));
        }
    });

    it("accepts a proxied request when it is allowed (an internal load balancer)", () => {
        expect(() => new InternalCallerGuard().check(request({ "x-forwarded-for": "10.1.1.1" }), true)).not.toThrow();
    });

    it("answers 429 to an address that presented too many wrong secrets, until the window passes", () => {
        vi.useFakeTimers();
        const guard = new InternalCallerGuard({ failureLimit: 3, failureWindowMs: 1000 });
        for (let i = 0; i < 3; i++) {
            guard.check(request());
            guard.noteFailure(request());
        }
        expect(() => guard.check(request())).toThrow(expect.objectContaining({ status: 429 }));
        expect(() => guard.check(request({}, "10.0.0.6"))).not.toThrow();
        vi.advanceTimersByTime(1001);
        expect(() => guard.check(request())).not.toThrow();
    });

    it("guards a route's authorizeInternalCaller: proxied is refused before the secret is looked at, a wrong secret is counted", () => {
        const inner = vi.fn((req: any) => {
            if (req.headers.authorization !== "Bearer ok") {
                throw new Error("forbidden");
            }
        });
        class Route {
            allowForwarded = false;
            authorizeInternalCaller(req: any): void {
                inner(req);
            }
        }
        guardInternalCaller(Route, new InternalCallerGuard({ failureLimit: 2 }));
        const route = new Route();
        expect(() => route.authorizeInternalCaller(request({ authorization: "Bearer ok", "x-forwarded-for": "1.2.3.4" }))).toThrow(
            expect.objectContaining({ status: 404 }),
        );
        expect(inner).not.toHaveBeenCalled();
        expect(() => route.authorizeInternalCaller(request({ authorization: "Bearer ok" }))).not.toThrow();
        expect(() => route.authorizeInternalCaller(request({ authorization: "Bearer no" }))).toThrow("forbidden");
        expect(() => route.authorizeInternalCaller(request({ authorization: "Bearer no" }))).toThrow("forbidden");
        expect(() => route.authorizeInternalCaller(request({ authorization: "Bearer ok" }))).toThrow(expect.objectContaining({ status: 429 }));
    });
});
