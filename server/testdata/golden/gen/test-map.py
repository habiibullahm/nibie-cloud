"""Write server/TEST-MAP.md: one row per TypeScript test case in test/ (unit and integration).

    python server/testdata/golden/gen/test-map.py           # write
    python server/testdata/golden/gen/test-map.py --check   # exit 1 if TEST-MAP.md is stale

Run from the repository root. Python 3, standard library only. A test case is one line that starts an
it(...) / test(...) call, including it.each / it.skip / it.skipIf / it.only; an it.each row stands for all of its
cases. Deleted in milestone M9 together with test/ (the map is then complete and frozen).
"""
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
OUT = os.path.join(ROOT, "server", "TEST-MAP.md")

TEST_LINE = re.compile(r"^\s*(it|test)(\.(each|skip|only|skipIf|runIf|todo|concurrent))*\(")
CALL_THEN_NAME = re.compile(r"""\)\(\s*(['"`])(.*?)\1""")
PLAIN_NAME = re.compile(r"""^\s*(?:it|test)(?:\.(?:skip|only|todo|concurrent))*\(\s*(['"`])(.*?)\1""")
TWO_CALLS = re.compile(r"^\s*(it|test)\.(each|skipIf|runIf)\(")

# Milestone per TS test file (spec section 6), by base name without .test.ts, for files not yet ported.
MILESTONE = {
    # M2 instances + jobs + operator API (network-policy integration drives InstanceService and the reconciler)
    "state-machine": 2, "backoff": 2, "errors": 2, "lease": 2, "instance-service": 2, "instance-commands": 2,
    "job-queue": 2, "job-scheduler": 2, "job-shutdown": 2, "job-sweeper": 2, "job-worker": 2, "recovery": 2,
    "reap-pending": 2, "persistence": 2, "disk-monitor": 2, "disk-wiring": 2, "disk-level": 2, "api": 2,
    "operator-jobs": 2, "schema": 2, "key-wiring": 2, "integration/network-policy": 2,
    # M3 auth, customer and public API, beta gate, waiting list
    "customer-api": 3, "customer-auth": 3, "identity-service": 3, "token-verifier": 3, "beta-invites": 3,
    "waitlist": 3, "turnstile": 3, "mask-email": 3, "client-ip": 3,
    # M4 secrets and integrations
    "secrets-crypto": 4, "secret-store": 4, "secrets-boundary": 4, "safe-fetch": 4, "telegram-service": 4,
    "provider-service": 4, "runtime-config": 4, "integration-routes": 4, "purge-and-logs": 4, "redact": 4,
    "ip-ranges": 4, "config-apply": 4,
    # M5 billing, mail, NibieRouter
    "billing-lifecycle": 5, "duitku-client": 5, "email-templates": 5, "mailer": 5, "svix": 5, "sumopod-webhook": 5,
    "billing-api": 5, "billing-service": 5, "billing-tick": 5, "nibierouter-client": 5, "router-provisioner": 5,
    # M6 admin and ops
    "admin-auth-rules": 6, "admin-api": 6, "admin-auth": 6, "admin-beta-invites": 6, "audit-service": 6,
    "alert-scanner": 6, "alerter": 6, "telegram-sink": 6, "admin-api-keys": 6, "admin-plan-stock": 6,
    # M7: host shell scripts in ops/egress (not Go code)
    "egress-rules": 7,
}
NOT_PORTED = {"redis-log": "not ported: the Go backend has no Redis (River keeps jobs in Postgres)"}

# Ported files: base name -> (status, Go test). M0 and M1.
PORTED = {
    "logger": ("ported", None),  # per test, below
    "readyz": ("ported", None),
    "config": ("golden", "internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues)"),
    "api-key": ("golden", "internal/runtime: TestAPIKeyGolden"),
    "hardening": ("golden", "internal/runtime: TestContainerConfigGolden, TestHardeningInvariants"),
    "image-policy": ("golden", "internal/runtime: TestImagePolicyGolden"),
    "network-config": ("golden", "internal/runtime: TestNamesGolden, TestNetworkConfigGolden"),
    "unit/network-policy": ("ported", "internal/runtime: TestNetworkPolicy (same subtest names)"),
    "volume-quota": ("ported", "internal/runtime: TestVolumeQuotaManager (same subtest names), TestVolumeQuotaGolden"),
    "runtime-health": ("ported", "internal/runtime: TestCheckHealth (same subtest names)"),
    "hermes-config": ("golden", "internal/runtime: TestModelBlockGolden, TestApplyTwiceWritesOnce, TestTarGolden, TestReadFirstFileGolden, TestCollectCappedStopsAtMax"),
    "unit/egress-canary": ("ported", "internal/runtime: TestEvaluateCanary, TestRunEgressCanary, TestCanaryScript (same subtest names)"),
    "dns-resolv-conf": ("ported", "internal/runtime: TestEnsureDNSResolvConf (same subtest names)"),
    "runtime-availability": ("ported", "internal/runtime: TestAssertRuntimeAvailable (same subtest names)"),
    "disk-quota-check": ("ported", "internal/runtime: TestAssertDiskQuotaSupported (same subtest names)"),
    "runtime-manager": ("ported", "internal/runtime: TestDockerManagerLive (same subtest names)"),
    "isolation": ("ported", "internal/runtime: TestTenantIsolation (same subtest names)"),
}
PER_TEST = {
    "logger": {
        "redacts tokens": "internal/shared/logger: TestRedactsTokensKeysEnvAndAuthorization",
        "keeps the /24": "internal/shared/logger: TestMaskIP",
        "treats an IPv4-mapped": "internal/shared/logger: TestMaskIP",
        "returns nothing": "internal/shared/logger: TestMaskIP",
        "writes the path": "internal/shared/logger: TestRequestAttrDropsQueryAndPort; internal/http: TestRequestLogLine",
    },
    "readyz": {
        "answers 200": "internal/http: TestReadyzOK",
        "answers 503": "internal/http: TestReadyzFailNamesOnly",
        "counts a check": "internal/http: TestReadyzTimeout",
    },
    "integration/egress-canary": {
        "a missing image": ("ported", "internal/runtime: TestCanaryMissingImageLeavesNothing"),
        "passes when the host rules": ("later: M8", "needs HERMES_CANARY_IMAGE and the host ruleset (VPS)"),
        "fails naming the gateway": ("later: M8", "needs HERMES_CANARY_IMAGE and no host ruleset (VPS)"),
    },
}


def test_name(lines, i):
    joined = " ".join(l.strip() for l in lines[i:i + 6])
    m = CALL_THEN_NAME.search(joined) if TWO_CALLS.match(lines[i]) else PLAIN_NAME.match(joined)
    return (m.group(2) if m else joined[:80]).replace("|", "/")


def classify(kind, base, name):
    key = f"{kind}/{base}"
    if key in PER_TEST or base in ("logger", "readyz"):
        table = PER_TEST.get(key) or PER_TEST.get(base)
        for prefix, v in table.items():
            if name.startswith(prefix):
                return (v[1], v[0]) if isinstance(v, tuple) else (v, "ported")
        return ("", "UNMAPPED")
    for k in (key, base):
        if k in PORTED:
            status, go = PORTED[k]
            return (go, status)
    if base in NOT_PORTED:
        return ("", NOT_PORTED[base])
    for k in (key, base):
        if k in MILESTONE:
            return ("", "later: M%d" % MILESTONE[k])
    return ("", "UNMAPPED")


def build():
    rows = []
    for kind in ("unit", "integration"):
        d = os.path.join(ROOT, "test", kind)
        for f in sorted(os.listdir(d)):
            if not f.endswith(".test.ts"):
                continue
            base = f[: -len(".test.ts")]
            with open(os.path.join(d, f), encoding="utf-8") as fh:
                lines = fh.read().splitlines()
            for i, line in enumerate(lines):
                if TEST_LINE.match(line):
                    name = test_name(lines, i)
                    go, status = classify(kind, base, name)
                    rows.append((f"test/{kind}/{f}", name, go, status))
    count = lambda pred: sum(1 for r in rows if pred(r[3]))
    out = [
        "# TEST-MAP: TypeScript tests and their Go counterparts",
        "",
        "Every test case of the Node backend (`test/unit`, `test/integration`) has one row: the Go test that covers it, or the",
        "milestone that will port it, or why it is not ported. A milestone's PR fills in its rows. Spec:",
        "`docs/superpowers/specs/2026-11-19-backend-go-port-design.md`, section 4. Generated by",
        "`server/testdata/golden/gen/test-map.py`; do not edit by hand.",
        "",
        "Status: `golden` (covered by a Node-generated golden fixture), `ported`, `later: M<n>`, `not ported: <reason>`.",
        "One row per `it(`, `test(`, `it.each(`, `it.skip(` or `it.skipIf(` line; an `it.each` row stands for all of its cases.",
        "",
        f"Rows: {len(rows)} (golden {count(lambda s: s == 'golden')}, ported {count(lambda s: s == 'ported')}, "
        f"later {count(lambda s: s.startswith('later'))}, not ported {count(lambda s: s.startswith('not ported'))}, "
        f"unmapped {count(lambda s: s == 'UNMAPPED')}).",
        "",
        "| TS file | TS test | Go test | Status |",
        "| --- | --- | --- | --- |",
    ]
    out += [f"| `{a}` | {b} | {c} | {d} |" for a, b, c, d in rows]
    return "\n".join(out) + "\n", rows


def main():
    body, rows = build()
    unmapped = [r for r in rows if r[3] == "UNMAPPED"]
    for r in unmapped:
        print("UNMAPPED", r[0], "-", r[1], file=sys.stderr)
    if "--check" in sys.argv:
        with open(OUT, encoding="utf-8") as fh:
            current = fh.read().replace("\r\n", "\n")
        if current != body or unmapped:
            print("stale or unmapped: " + OUT, file=sys.stderr)
            sys.exit(1)
        print("test-map up to date")
        return
    with open(OUT, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(body)
    print(f"{len(rows)} rows written, {len(unmapped)} unmapped")
    sys.exit(1 if unmapped else 0)


main()
