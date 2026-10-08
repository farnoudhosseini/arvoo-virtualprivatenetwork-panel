-- Canonical GRE keys.
--
-- GRE carries an optional 32-bit key field (RFC 2890). The agents only accept it
-- in hexadecimal, 1-8 characters, case-insensitive (max ffffffff). Until this
-- migration the control plane generated it with
--
--   key = String(Math.abs(ipToInt(local_tunnel_ip)) % 2147483647)
--
-- which renders a DECIMAL integer: the tunnel 10.200.0.1 on 10.200.0.0/30 got
-- "180879361" - nine digits. That is not a hex key, so the agent rejected the
-- CreateGRE payload ("key must be a 1-8 digit hexadecimal GRE key") and the
-- tunnel never came up.
--
-- Every value in this column was written by that generator (the UI only ever had
-- "auto"/"no key"), so each stored value denotes the DECIMAL integer it spells.
-- Rewriting it as the hexadecimal spelling of that same integer (180879361 ->
-- 'ac80001') is therefore value-preserving: the 32-bit key field on the wire is
-- unchanged, only its textual form is. A value that spells something that is not
-- an unsigned 32-bit integer can never be applied and is cleared so the tunnel is
-- re-keyed explicitly instead of being deployed with a bogus key.
UPDATE tunnels
   SET key = CASE
     -- Legacy decimal generator output: the same 32-bit value in canonical hex.
     WHEN key ~ '^[0-9]{1,10}$' THEN
       CASE WHEN key::bigint <= 4294967295 THEN to_hex(key::bigint) ELSE NULL END
     -- Already hexadecimal (possibly upper-case): canonicalise the case.
     WHEN key ~ '^[0-9a-fA-F]{1,8}$' THEN lower(key)
     ELSE NULL
   END
 WHERE key IS NOT NULL;

-- Nothing but a canonical key may be stored from now on, so an invalid key can
-- never reach the operation queue again.
ALTER TABLE tunnels ADD CONSTRAINT tunnels_key_canonical
  CHECK (key IS NULL OR key ~ '^[0-9a-f]{1,8}$');
