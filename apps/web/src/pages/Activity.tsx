import { AuditPage } from "./Audit";

/**
 * Activity = the live event feed of the platform. The audit log already IS
 * that feed (structured, immutable, actor-attributed), so this view reuses it
 * rather than duplicating a second event store.
 */
export function ActivityPage() {
  return <AuditPage />;
}
