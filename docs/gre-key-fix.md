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

## Verification performed in this workspace

* `npx vitest run` → **20 files, 324 tests passing**; `npm run typecheck` and
  `npm run build` → exit 0 (web bundle included, so the shared value import resolves).
* `packages/shared/src/gre.test.ts` covers the full matrix: `1`, `a`, 8-char keys,
  lower/upper/mixed case, `0x`/`0X`, `0`, `ffffffff`, `100000000` → reject,
  `G1234567` → reject, empty → reject, `180879361` → reject, and that
  `greKeyFromBytes` can never emit an invalid key.
* `apps/agent/test/gre-key.test.ts` asserts the exact argv
  (`... ttl 255 key 0xac80001`) and that a digits-only key is not read as decimal.
* `apps/api/test/api.test.ts` posts the decimal key through the real HTTP route and
  asserts `400` **and that no tunnel row and no operation were created**; it also
  asserts both queued `CreateGRE` payloads carry the canonical key.
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

The agent reports the key it read back (`output.key`, `output.keyVerified`) with the
CreateGRE result, and fails the operation outright if the kernel installed a
different key — so the panel state for a keyed tunnel is derived from the kernel, not
assumed. A tunnel only becomes `up` when both sides report success
(`onGreOperationSettled`); a failed or unverified deployment stays `error`/`degraded`.
