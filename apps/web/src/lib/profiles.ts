/** Client-side mirror of @arvoo/shared PERFORMANCE_PROFILES for the builder UI. */
export const PROFILE_DESCRIPTIONS: Record<string, { label: string; rationale: string }> = {
  balanced: {
    label: "Balanced",
    rationale: "Safe general-purpose defaults: UDP transport, sane socket buffers, standard keepalive.",
  },
  "low-latency": {
    label: "Low Latency",
    rationale: "Prioritises response time: fast-io, tighter keepalive for quick failover detection, TCP_NODELAY on TCP.",
  },
  throughput: {
    label: "High Throughput",
    rationale: "Prioritises sustained transfer: enlarged socket buffers (512 KB), longer keepalive to avoid dropping busy sessions.",
  },
  compatibility: {
    label: "Compatibility",
    rationale: "Maximum client compatibility: conservative TLS settings, AES-256-CBC fallback, tls-auth control channel.",
  },
};
