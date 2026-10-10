/** Client-side mirror of @arvoo/shared PERFORMANCE_PROFILES for the builder UI. */
export const PROFILE_DESCRIPTIONS: Record<string, { label: string; rationale: string }> = {
  balanced: {
    label: "Balanced",
    rationale: "Safe general-purpose defaults: sane socket buffers, standard keepalive. Works on UDP or TCP.",
  },
  "low-latency": {
    label: "Low Latency",
    rationale: "Minimises RTT: tcp-nodelay, modest buffers, tight keepalive. Best for interactive use.",
  },
  "tcp-boost": {
    label: "TCP Boost",
    rationale:
      "Optimised for TCP when UDP is blocked: 1MB socket buffers, TCP_NODELAY, tuned MSS/MTU for GRE+OpenVPN overhead. Aim for higher Mbps and lower ACK delay.",
  },
  throughput: {
    label: "High Throughput",
    rationale: "Maximises Mbps: large socket buffers (1 MB), longer keepalive. Prefer for downloads on stable links.",
  },
  compatibility: {
    label: "Compatibility",
    rationale: "Maximum client compatibility: conservative TLS settings, AES-256-CBC fallback, tls-auth control channel.",
  },
};
