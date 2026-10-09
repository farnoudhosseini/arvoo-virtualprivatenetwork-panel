# GRE key fix: root cause, change, verification

## The bug

`apps/api/src/services/tunnels.ts` derived the GRE key from the tunnel transport
address and rendered it as a **decimal integer**:

```ts
keyed ? String(Math.abs(ipToInt(local)) % 2147483647) : null
```

`10.200.0.0/30` → `local = 10.200.0.1` → `ipToInt = 180879361`, so the row and the
queued payload carried the string `"180879361"` — nine characters, not a hex key.
The agent validates the key as `^[0-9a-fA-F]{1,8}$` at its privileged boundary and
refused the operation:

```
Rejected invalid operation payload: key must be a 1-8 digit hexadecimal GRE key
```

Both `CreateGRE` operations (source and destination node) failed, the tunnel stayed
in `deploying`, and no Linux interface was ever created. The generator — not the
validator — was wrong: a GRE key is an unsigned 32-bit field (RFC 2890), and
180879361 is `0x0ac80001`, which has a perfectly valid 7-character spelling.

## The canonical representation (Web, API and Agent)

`packages/shared/src/gre.ts` is now the single definition:

* stored/transmitted form: **lowercase hexadecimal, 1-8 characters** (no `0x`,
  no leading zeros, max `ffffffff`);
* accepted operator input: the same, case-insensitively and optionally `0x`-prefixed;
* `null` means *no key field* — it is not the same as key `0`;
* a decimal integer is **not** a valid key. `canonicalGreKey("180879361")` is `null`.

Helpers: `isValidGreKey`, `canonicalGreKey`, `canonicalGreKeyFromDecimal`,
`greKeyFromBytes`, `greKeyCliValue`, `greKeyFromLinkShow`, `GRE_KEY_RULE`.

## What changed

| Area | Change |
| --- | --- |
| `packages/shared/src/gre.ts` | canonical key module + the rule text used by API and agent |
| `packages/shared/src/types.ts` | documents `TunnelRecord.key` / `GreOpInput.key`; adds optional `key`/`keyVerified` to `TunnelTestResult` |
| `apps/api/src/services/tunnels.ts` | `resolveGreKey()`: `true`/omitted → random 32-bit key in hex, `false` → keyless, string → canonicalised or `400`. The decimal expression is gone |
| `apps/api/src/routes/index.ts` | `POST /tunnels` accepts `key: boolean \| string \| null`; bad values are refused before anything is queued |
| `apps/agent/src/validate-op.ts` | re-validates against the **same** shared rule (defence in depth) |
| `apps/agent/src/ops.ts` | `greLinkArgs()` builds the argv; the key goes to `ip` as `0x<hex>` (iproute2 parses `key` with base 0, so a bare hex string with letters is rejected and a digits-only value would be read as decimal). After creation the agent reads the key back from `ip -d link show` and **fails** if the kernel installed a different one |
| `apps/api/src/migrations/0005_gre_key_canonical.sql` | canonicalises existing rows and adds a `CHECK` constraint |
| `apps/web/src/pages/Tunnels.tsx`, `TunnelDetail.tsx` | custom hex key option with live validation/normalisation; the detail page shows `0x<key>` and its decimal value |
| `packages/shared/src/gre.ts` | `greLinkStateFromLinkShow` / `tunnelAddressesFromAddrShow` / `routeDeviceFromRouteGet` / `verifyGreTunnel` - pure inspectors and the field-by-field comparison used by TestTunnel |
| `apps/agent/src/ops.ts` | `testGre()` verifies the kernel instead of echoing the request; `runBenchmark()` reports received samples and fails on zero measurements |
| `apps/api/src/services/tunnels.ts` | `testTunnel()` queues the expected configuration so the node can compare it |

### The migration and existing values

Every key ever written to `tunnels.key` came from the decimal generator (the UI only
had "auto"/"no key"), so each stored value denotes the **decimal integer it spells**.
`to_hex(value)` is therefore value-preserving, not a reinterpretation:

* `180879361` → `ac80001` (same 32-bit field as 180879361, now applicable)
* `12345678` → `bc614e` (this preserves the *decimal* value; reading 12345678 as hex
  would have silently installed key `0x12345678` instead — that is exactly the
  reinterpretation the migration must not do)
* already-hex values are only lower-cased;
* a value that is neither a 32-bit decimal nor hex (not representable at all, so it
  could never have been applied) is set to `NULL` so the tunnel is re-keyed
  deliberately.

The `tunnels_key_canonical` `CHECK` constraint means an invalid key can no longer be
stored, so it can never reach the operation queue again. The `.down.sql` drops the
constraint; the rewrite itself is intentionally not reversed (a migrated key is
indistinguishable from one that was always hex, so reversing would have to guess).

## TestTunnel and RunBenchmark: real verification, not a superficial pass

The second reported symptom was a `TestTunnel` that "succeeded" on a tunnel whose
`RunBenchmark` could not get a single ICMP reply. The old agent code was the reason:
it looked only at whether the interface **existed**, pinged once, and returned
`mtuDetected: input.mtu` - the MTU it had just been asked to configure. A tunnel
with the wrong key, the wrong tunnel address, or no route at all could pass.

`testGre()` now reads the data plane back from the kernel and compares it with the
configuration the panel queued (`TestTunnelOpInput`):

| Check | Source |
| --- | --- |
| interface exists / administratively up / carrier | `ip -d link show` flags |
| local + remote endpoints, ttl, mtu | `ip -d link show` detail fields |
| GRE key (canonical, never assumed) | `key ...` in the detailed dump |
| tunnel address + prefix | `ip -4 addr show dev <if>` |
| route to the remote tunnel IP | `ip route get <remote>` selects `<if>` |
| data plane | real `ping -c 5 -I <if>` across the tunnel |

Every check is reported individually (`failedChecks`, `endpointVerified`,
`mtuVerified`, `keyVerified`, `addressVerified`, `routeOk`, `pingOk`, `ifUp`,
`carrierUp`) and checks the payload does not carry stay `null` - *not verifiable*,
never a silent pass. When any verifiable check fails, the **operation is reported
failed** with the failing checks named, so the dashboard can no longer show a green
TestTunnel for a tunnel that carries nothing. `mtuDetected` is now the MTU the
kernel reports.

`runBenchmark()` reports the ICMP replies it actually received (`samples`), fails on
zero measurements or total loss with an explicit cause, and surfaces partial
connectivity as a `warning` instead of averaging it away. iperf3 throughput is still
only added when iperf3 actually produced it.

### Exactly-once claiming

`claimNextOperation()` now claims as a compare-and-set: only the poll whose
`UPDATE ... WHERE id = ? AND status = 'queued'` actually changes a row gets the
operation. Two pollers at the same moment (a duplicated agent process, or a retry
while the previous poll is in flight) used to select the same candidate and both
execute it - a second `ip link`/systemd run for the same operation. The loser now
receives `{ operation: null }` and polls again; the row and its `claimed_at` reflect
the single real claim.

## Verification performed in this workspace

* `npx vitest run` → **22 files, 367 tests passing**; `npm run typecheck` and
  `npm run build` → exit 0 (web bundle included, so the shared value import resolves).
* `packages/shared/src/gre.test.ts` covers the full matrix: `1`, `a`, 8-char keys,
  lower/upper/mixed case, `0x`/`0X`, `0`, `ffffffff`, `100000000` → reject,
  `G1234567` → reject, empty → reject, `180879361` → reject, and that
  `greKeyFromBytes` can never emit an invalid key.
* `apps/agent/test/gre-key.test.ts` asserts the exact argv
  (`... ttl 255 key 0xac80001`) and that a digits-only key is not read as decimal.
* `apps/api/test/api.test.ts` posts the decimal key through the real HTTP route and
  asserts `400` **and that no tunnel row and no operation were created**; it also
  asserts both queued `CreateGRE` payloads carry the canonical key, and that the
  queued `TestTunnel` payload carries the full expected configuration from storage.
* `packages/shared/src/tunnel-verify.test.ts` (22 tests) feeds real `iproute2`
  output to the inspectors and asserts the verdicts: healthy, wrong key, keyless
  tunnel with a key, MTU/ttl mismatch, missing address, wrong or absent route,
  administratively down, missing interface, blocked ICMP, and the legacy payload.
* `apps/agent/test/tunnel-verify.test.ts` (18 tests) drives the real executor with a
  mocked `exec` seam and asserts the *operation result*: an interface that exists
  and answers ping but has the wrong key **fails** (this is the "superficial check"
  regression), and `/benchmark` on a silent tunnel fails with `100% packet loss`
  instead of returning empty measurements.
* `apps/api/test/api.test.ts` additionally asserts that a concurrent double poll of
  `/api/v1/agent/operations` hands the operation out exactly once, and that the
  queued `TestTunnel` payload carries the expected configuration from storage.
* The real agent runner was driven with the panel-built payloads (`executeOperation`):
  the full expectation, the legacy three-field shape and a keyless expectation are all
  accepted at the privileged boundary (and then fail honestly with "requires a Linux
  node" on this Windows host), while a legacy decimal key and a malformed endpoint are
  refused with `Rejected invalid operation payload: ...`.
* `apps/api/test/migrations.test.ts` seeds pre-0005 decimal rows, re-runs the
  migration and asserts `180879361→ac80001`, `12345678→bc614e`, and that an
  unrepresentable value is cleared. (The test now allocates a free port via
  `findFreePort()` — the hardcoded one collided with a running dev database.)

### Live end-to-end run (panel → queue → real agent)

A scratch control plane was started against a throwaway PostgreSQL (free ports), two
nodes were created through the HTTP API, **real agent processes** enrolled for each
of them, and the tunnel was created through the same endpoint the UI uses:

```
PASS  agent rejects the legacy decimal GRE key
      Rejected invalid operation payload: key must be 1-8 hexadecimal digits
      (case-insensitive, max "ffffffff"), e.g. "ac80001"
PASS  generated key is canonical lowercase hex — key=753a5184
[e2e] GRE-A queue payload: {... "key":"753a5184" ...}
[e2e] GRE-B queue payload: {... "key":"753a5184" ...}   (same key, both sides)
PASS  GRE-A/GRE-B: agent accepts the payload (fails only on the non-Linux host)
      This operation requires a Linux node (iproute2/systemd/OpenVPN)...
PASS  stored key matches the queued key — {"key":"753a5184","status":"error"}
PASS  tunnel was not marked up by a failed deployment — status=error
PASS  audit history preserved — entries=1
```

So the rejection is reproduced on the real agent code path, and the panel-generated
key passes agent validation on both sides. The deployment itself stops at "not a
Linux host" because this workspace is Windows.

## Not verified here: TCI-01 / TR-01

Those nodes are not reachable from this workspace (no panel URL, credentials, SSH or
agent connected here), so the following were **not** executed and must run on the
deployment that owns the tunnel:

```bash
# 1. On the panel host: canonicalise the affected row and add the constraint.
npm run db:migrate                     # applies 0004 (if missing) + 0005
psql "$DATABASE_URL" -c "SELECT name, key, status FROM tunnels ORDER BY created_at"

# 2. Re-create/re-key the affected tunnel (audit history of the failed attempt is
#    preserved; the old row's operations stay in the log).
#    Either fix the existing row and re-deploy:
#      UPDATE tunnels SET key = 'ac80001', status = 'planned' WHERE name = '<name>';  -- via migration for decimals
#      POST /api/v1/tunnels/<id>/deploy
#    or delete it and create a fresh one in the UI (key = "Auto-generated") which
#      queues CreateGRE to both nodes.
curl -sS -X POST "$PANEL/api/v1/tunnels/<id>/deploy" -H "authorization: Bearer $TOKEN"

# 3. On BOTH nodes — the interface must exist with the key, MTU, addresses and routes:
ip -d link show <ifname>            # expect: gre remote <peer> local <local> ttl 255 key 0x<hex>
ip -4 addr show <ifname>            # expect: 10.200.0.1/30 (TCI-01) / 10.200.0.2/30 (TR-01)
ip link show <ifname> | grep mtu    # expect: mtu 1452
ip route show dev <ifname>          # expect the tunnel routes the panel pushed

# 4. Bidirectional reachability + the benchmark operation:
ping -c 3 -I <ifname> 10.200.0.2    # TCI-01 -> TR-01
ping -c 3 -I <ifname> 10.200.0.1    # TR-01 -> TCI-01
#    then POST /api/v1/tunnels/<id>/test and /benchmark and compare the reported
#    latency/loss against the pings above.
```

The TestTunnel operation must settle as `success` with `ok: true` and
`failedChecks: []`. If it settles as `failed`, its error names the failing checks
(`key`, `address`, `route`, `ping`, ...) and the operation output carries the value
the kernel reported next to the expected one - run the same `ip` commands above to
see it directly. A benchmark on a tunnel that answers nothing now fails with
`100% packet loss to <ip> across <ifname>` and stores no measurements.

The agent reports the key it read back (`output.key`, `output.keyVerified`) with the
CreateGRE result, and fails the operation outright if the kernel installed a
different key — so the panel state for a keyed tunnel is derived from the kernel, not
assumed. A tunnel only becomes `up` when both sides report success
(`onGreOperationSettled`); a failed or unverified deployment stays `error`/`degraded`.
