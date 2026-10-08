-- Arvoo Control Plane - reverse of 0001_init.sql.
--
-- DESTRUCTIVE: this drops every table created by the initial schema, including
-- all rows in them. It exists so a downgrade is explicit and reproducible
-- (`npm run db:migrate -- --down 1 --force`), not so it can be run casually.
--
-- The migration runner records this in _migrations bookkeeping; the table
-- itself is owned by the runner and is intentionally not dropped here.
-- CASCADE resolves the foreign keys between these tables in one statement.

DROP TABLE IF EXISTS
  client_inbounds,
  inbound_secrets,
  node_telemetry,
  pki_certificates,
  settings,
  alerts,
  audit_logs,
  operation_logs,
  routes,
  tunnels,
  policy_rules,
  client_usage_samples,
  client_sessions,
  client_devices,
  client_secrets,
  clients,
  client_groups,
  inbound_deployments,
  inbound_versions,
  inbounds,
  operations,
  node_health_samples,
  enrollment_tokens,
  nodes,
  role_permissions,
  permissions,
  roles,
  users
CASCADE;
