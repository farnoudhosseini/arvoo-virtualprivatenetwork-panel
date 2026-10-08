/**
 * Chart theme.
 *
 * Recharts takes literal values, not Tailwind classes, so every chart in the
 * panel reads its palette from here — this is what keeps the dashboard, node
 * health and tunnel charts looking like they belong to the same product.
 */
export const chart = {
  grid: "var(--line)",
  axis: "var(--faint)",
  accent: "var(--accent)",
  info: "var(--info)",
  success: "var(--success)",
  warning: "var(--warning)",
  danger: "var(--danger)",
  tooltip: {
    background: "var(--surface-2)",
    border: "1px solid var(--line-strong)",
    borderRadius: 8,
    fontSize: 12,
    padding: "6px 10px",
    boxShadow: "0 12px 32px -16px rgba(0,0,0,0.9)",
  } as const,
  tooltipLabel: { color: "var(--muted)", fontSize: 10, textTransform: "uppercase" as const, letterSpacing: "0.08em" },
  tick: { fill: "var(--faint)", fontSize: 10 },
} as const;
