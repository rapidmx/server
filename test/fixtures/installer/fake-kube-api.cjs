// A stand-in Kubernetes API server for test/installer/dns.test.ts: just enough discovery for the real kubectl to list DNSEndpoints, which it answers
// with the list in the file named by argv[2]. It prints its port on its first line of output and logs each request URL to argv[3].
const http = require("http");
const fs = require("fs");

const [, , listFile, requestLog] = process.argv;

const groupVersion = "externaldns.k8s.io/v1alpha1";
const server = http.createServer((req, res) => {
    fs.appendFileSync(requestLog, `${req.method} ${req.url}\n`);
    const send = (body, status = 200) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
    };
    const path = req.url.split("?")[0];
    if (path === "/api") {
        return send({ kind: "APIVersions", versions: ["v1"] });
    }
    if (path === "/apis") {
        return send({ kind: "APIGroupList", apiVersion: "v1", groups: [{ name: "externaldns.k8s.io", versions: [{ groupVersion, version: "v1alpha1" }], preferredVersion: { groupVersion, version: "v1alpha1" } }] });
    }
    if (path === "/api/v1") {
        return send({ kind: "APIResourceList", groupVersion: "v1", resources: [] });
    }
    if (path === `/apis/${groupVersion}`) {
        return send({
            kind: "APIResourceList",
            groupVersion,
            resources: [{ name: "dnsendpoints", singularName: "dnsendpoint", namespaced: true, kind: "DNSEndpoint", verbs: ["get", "list", "watch", "delete"] }],
        });
    }
    if (path === `/apis/${groupVersion}/namespaces/rapidmx/dnsendpoints`) {
        return send(JSON.parse(fs.readFileSync(listFile, "utf8")));
    }
    send({ kind: "Status", apiVersion: "v1", status: "Failure", reason: "NotFound", code: 404 }, 404);
});
server.listen(0, "127.0.0.1", () => {
    console.log(server.address().port);
});
