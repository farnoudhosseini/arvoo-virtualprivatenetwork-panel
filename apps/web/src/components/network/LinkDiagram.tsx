import { type ReactNode } from "react";
import { Server, ArrowRight } from "lucide-react";
import { StatusDot, UnifiedStatus, cx, type StatusTone } from "../ui/primitives";

/**
 * Node ── tunnel ── Node.
 *
 * The panel's network fabric is point-to-point, so the clearest representation
 * is a literal path rather than an abstract graph: two endpoints with the link
 * attributes in between. The dashed track only animates while the link is up —
 * motion here carries meaning (traffic flowing), it is not decoration.
 */
export function LinkDiagram({
  source,
  dest,
  label,
  status,
  metrics,
  compact,
  onSourceClick,
  onDestClick,
}: {
  source: { name: string; address?: string | null; status?: string };
  dest: { name: string; address?: string | null; status?: string };
  label: ReactNode;
  status: string;
  metrics?: ReactNode;
  compact?: boolean;
  onSourceClick?: () => void;
  onDestClick?: () => void;
}) {
  const active = status === "up" || status === "deploying";

  return (
    <div className={cx("flex items-center gap-2", compact ? "gap-2" : "gap-3")}>
      <Endpoint node={source} onClick={onSourceClick} compact={compact} />
      <div className="relative flex min-w-[60px] flex-1 items-center">
        <span className={cx("h-px w-full", active ? "link-dash" : "link-dash-idle")} aria-hidden />
        <span className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1 whitespace-nowrap rounded-full border border-line bg-surface px-2 py-0.5">
          <span className="flex items-center gap-1.5 text-3xs font-medium uppercase tracking-wider text-muted">
            {label}
            <StatusDot tone={tone(status)} live={status === "up"} />
          </span>
        </span>
        {metrics && (
          <span className="absolute left-1/2 top-full mt-1.5 -translate-x-1/2 whitespace-nowrap text-3xs text-faint">{metrics}</span>
        )}
      </div>
      <Endpoint node={dest} onClick={onDestClick} compact={compact} />
    </div>
  );
}

function Endpoint({
  node,
  onClick,
  compact,
}: {
  node: { name: string; address?: string | null; status?: string };
  onClick?: () => void;
  compact?: boolean;
}) {
  const Comp = onClick ? "button" : "div";
  return (
    <Comp
      {...(onClick ? { type: "button" as const, onClick } : {})}
      className={cx(
        "flex min-w-0 shrink-0 items-center gap-2 rounded-default border border-line bg-surface-2 text-left",
        compact ? "px-2 py-1.5" : "px-2.5 py-2",
        onClick && "transition-colors duration-fast hover:border-line-strong hover:bg-surface-3",
      )}
    >
      <Server size={13} className="shrink-0 text-faint" />
      <span className="flex min-w-0 flex-col items-start">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-2xs font-medium text-text">{node.name}</span>
          {node.status && <UnifiedStatus status={node.status} />}
        </span>
        {!compact && node.address && <span className="mono mt-0.5 truncate text-3xs text-faint">{node.address}</span>}
      </span>
    </Comp>
  );
}

function tone(status: string): StatusTone {
  if (status === "up") return "success";
  if (status === "degraded" || status === "deploying") return "warning";
  if (status === "down" || status === "error") return "danger";
  return "neutral";
}

export { ArrowRight };
