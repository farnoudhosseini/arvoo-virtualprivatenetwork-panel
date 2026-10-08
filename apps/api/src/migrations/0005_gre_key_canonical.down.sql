-- Reverse of 0005_gre_key_canonical.sql: drops the key constraint.
--
-- The key rewrite itself is deliberately NOT reversed. 'ac80001' is the canonical
-- spelling of the same 32-bit key the legacy decimal row denoted, and a migrated
-- key is indistinguishable from a key that was always hexadecimal, so converting
-- back would have to guess and could hand the kernel a different key value.
ALTER TABLE tunnels DROP CONSTRAINT IF EXISTS tunnels_key_canonical;
