/**
 * Arvoo primitive components.
 *
 * These are the only place where surface, spacing, motion and status styling is
 * defined for the whole panel — pages compose them instead of styling raw
 * elements, which is what keeps 16 screens looking like one product.
 *
 * Rules encoded here:
 *   * surfaces are layered panels (.panel) with hairline borders
 *   * interaction feedback is fast (120–180ms) and never bouncy
 *   * status color is always paired with a shape (dot) and a label
 *   * numbers are tabular so live values do not shift the layout
 */
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { clsx } from "clsx";
import { Check, Copy, Loader2, TrendingDown, TrendingUp } from "lucide-react";
import { useState } from "react";

export function cx(...args: Parameters<typeof clsx>) {
  return clsx(...args);
}

// --------------------------------------------------------------------- Button

export type ButtonVariant = "primary" | "secondary" | "ghost" | "subtle" | "danger" | "success";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

/**
 * Primary = accent red, reserved for the one main action of a screen.
 * Secondary = bordered surface (default). Ghost = toolbar/row actions.
 */
const buttonVariants: Record<ButtonVariant, string> = {
  primary:
    "text-accent-fg border-accent/60 bg-accent hover:bg-accent-hover hover:border-accent-hover shadow-[0_1px_0_rgba(255,255,255,0.12)_inset,0_6px_18px_-10px_var(--accent-glow)]",
  secondary:
    "text-text border-line bg-surface-2 hover:bg-surface-3 hover:border-line-strong shadow-[0_1px_0_rgba(255,255,255,0.03)_inset]",
  ghost: "text-muted border-transparent bg-transparent hover:text-text hover:bg-surface-3",
  subtle: "text-text border-transparent bg-surface-3 hover:bg-line-strong/70",
  danger:
    "text-white border-danger/60 bg-danger hover:bg-danger/90 shadow-[0_6px_18px_-12px_rgba(229,72,77,0.6)]",
  success: "text-white border-success/60 bg-success hover:bg-success/90",
};

const buttonSizes: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-2xs gap-1.5",
  md: "h-8 px-3.5 text-[13px] gap-2",
  lg: "h-9 px-4 text-[13px] gap-2",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "secondary", size = "md", loading, className, children, disabled, ...rest }, ref) => (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cx(
        "inline-flex select-none items-center justify-center rounded-default border font-medium",
        "transition-[background-color,border-color,color,transform,box-shadow] duration-fast ease-arvoo",
        "active:translate-y-[0.5px] active:scale-[0.985]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 focus-visible:ring-offset-1 focus-visible:ring-offset-bg",
        "disabled:pointer-events-none disabled:opacity-45",
        buttonSizes[size],
        buttonVariants[variant],
        className,
      )}
      {...rest}
    >
      {loading && <Loader2 size={13} className="animate-spin" />}
      {children}
    </button>
  ),
);
Button.displayName = "Button";

/** Square icon-only button; always give it an aria-label. */
export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "ghost" | "secondary" | "danger" }>(
  ({ className, children, variant = "ghost", ...rest }, ref) => (
    <button
      ref={ref}
      className={cx(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-default border transition-colors duration-fast ease-arvoo",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45",
        variant === "ghost" && "border-transparent text-muted hover:bg-surface-3 hover:text-text",
        variant === "secondary" && "border-line bg-surface-2 text-muted hover:border-line-strong hover:text-text",
        variant === "danger" && "border-transparent text-muted hover:bg-danger/15 hover:text-danger",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  ),
);
IconButton.displayName = "IconButton";

// --------------------------------------------------------------------- Inputs

const fieldBase =
  "w-full rounded-default border border-line bg-surface-inset text-[13px] text-text placeholder:text-faint shadow-inset " +
  "transition-[border-color,box-shadow] duration-fast ease-arvoo hover:border-line-strong " +
  "focus:outline-none focus:border-accent/60 focus:ring-2 focus:ring-accent/20";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...rest }, ref) => (
    <input ref={ref} className={cx(fieldBase, "h-8 px-2.5", className)} {...rest} />
  ),
);
Input.displayName = "Input";

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...rest }, ref) => (
    <textarea ref={ref} className={cx(fieldBase, "mono resize-y px-2.5 py-2 text-xs leading-relaxed", className)} {...rest} />
  ),
);
Textarea.displayName = "Textarea";

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...rest }, ref) => (
    <select
      ref={ref}
      className={cx(
        fieldBase,
        "h-8 cursor-pointer appearance-none bg-[length:12px] bg-[right_0.6rem_center] bg-no-repeat px-2.5 pr-7",
        "bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%239aa1ad%22 stroke-width=%222%22><path d=%22M6 9l6 6 6-6%22/></svg>')]",
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  ),
);
Select.displayName = "Select";

/**
 * Checkbox with an indeterminate state — used by table selection, where the
 * header box must express "some rows selected".
 */
export function Checkbox({
  checked,
  indeterminate,
  onCheckedChange,
  label,
  className,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  className?: string;
}) {
  return (
    <span
      role="checkbox"
      aria-checked={indeterminate ? "mixed" : checked}
      aria-label={label}
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        onCheckedChange(!checked);
      }}
      onKeyDown={(e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          onCheckedChange(!checked);
        }
      }}
      className={cx(
        "inline-flex size-3.5 shrink-0 cursor-pointer items-center justify-center rounded-[4px] border transition-colors duration-fast",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
        checked || indeterminate ? "border-accent bg-accent text-white" : "border-line-strong bg-surface-inset hover:border-muted",
        className,
      )}
    >
      {indeterminate ? (
        <span className="block h-[1.5px] w-2 rounded-full bg-white" />
      ) : checked ? (
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      ) : null}
    </span>
  );
}

/** Toggle switch — used where a change applies immediately (policy on/off). */
export function Switch({
  checked,
  onCheckedChange,
  label,
  disabled,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onCheckedChange(!checked);
      }}
      className={cx(
        "relative inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full border transition-colors duration-fast ease-arvoo",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
        checked ? "border-accent/60 bg-accent/90" : "border-line bg-surface-3",
        disabled && "pointer-events-none opacity-40",
      )}
    >
      <span
        className={cx(
          "absolute size-3 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.5)] transition-transform duration-slow ease-arvoo",
          checked ? "translate-x-[16px]" : "translate-x-[2px]",
        )}
      />
    </button>
  );
}

/** Labelled form row with hint and error slots. */
export function Field({
  label,
  hint,
  error,
  required,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("space-y-1.5", className)}>
      <label className="flex items-center gap-1.5 text-xs font-medium text-muted">
        {label}
        {required && <span className="text-accent" aria-hidden>*</span>}
      </label>
      {children}
      {hint && !error && <p className="text-2xs leading-snug text-faint">{hint}</p>}
      {error && <p className="text-2xs leading-snug text-danger">{error}</p>}
    </div>
  );
}

/** Label + copy-to-clipboard value (tokens, IDs, endpoints). */
export function CopyField({ label, value }: { label?: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1.5">
      {label && <div className="text-xs font-medium text-muted">{label}</div>}
      <div className="flex items-center gap-2 rounded-default border border-line bg-surface-inset px-2.5 py-1.5 shadow-inset">
        <span className="mono min-w-0 flex-1 truncate text-2xs text-text">{value}</span>
        <button
          type="button"
          aria-label={`Copy ${label ?? "value"}`}
          className="inline-flex items-center gap-1 text-2xs text-muted transition-colors hover:text-text"
          onClick={() => {
            void navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- Surfaces

export function Card({
  className,
  children,
  interactive,
  glass,
}: {
  className?: string;
  children: ReactNode;
  interactive?: boolean;
  glass?: boolean;
}) {
  return <div className={cx(glass ? "panel-glass" : "panel", interactive && "panel-hover", className)}>{children}</div>;
}

export function CardHeader({
  title,
  desc,
  actions,
  icon,
}: {
  title: ReactNode;
  desc?: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
      <div className="flex min-w-0 items-start gap-2.5">
        {icon && <span className="mt-0.5 text-faint">{icon}</span>}
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold leading-tight text-text">{title}</h3>
          {desc && <p className="mt-0.5 text-2xs leading-snug text-muted">{desc}</p>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </div>
  );
}

/** Uppercase micro-label used to group sections. */
export function SectionLabel({ children, className, actions }: { children: ReactNode; className?: string; actions?: ReactNode }) {
  return (
    <div className={cx("mb-2 flex items-center justify-between gap-3", className)}>
      <span className="label-micro">{children}</span>
      {actions}
    </div>
  );
}

export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("toolbar", className)}>{children}</div>;
}

// ---------------------------------------------------------------------- Status

export type StatusTone = "success" | "warning" | "danger" | "info" | "neutral" | "accent";

const toneClasses: Record<StatusTone, string> = {
  success: "text-success border-success/25 bg-success-soft",
  warning: "text-warning border-warning/25 bg-warning-soft",
  danger: "text-danger border-danger/25 bg-danger-soft",
  info: "text-info border-info/25 bg-info-soft",
  neutral: "text-muted border-line bg-surface-3",
  accent: "text-accent border-accent/30 bg-accent-soft",
};

export function Badge({
  tone = "neutral",
  children,
  className,
  mono,
}: {
  tone?: StatusTone;
  children: ReactNode;
  className?: string;
  mono?: boolean;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-2xs font-medium",
        mono && "mono tracking-tight",
        toneClasses[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

const dotColor: Record<StatusTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  info: "bg-info",
  neutral: "bg-faint",
  accent: "bg-accent",
};

/**
 * Status is always a dot + text so it survives color-blindness and greyscale
 * printing. `live` adds a soft pulse for states that are actively updating.
 */
export function StatusDot({ tone, live }: { tone: StatusTone; live?: boolean }) {
  return (
    <span className="relative inline-flex size-1.5 shrink-0">
      <span className={cx("size-1.5 rounded-full", dotColor[tone])} />
      {live && <span className={cx("absolute inset-0 animate-ping rounded-full opacity-60", dotColor[tone])} />}
    </span>
  );
}

export function StatusBadge({ status, tone, label, live }: { status: string; tone: StatusTone; label?: string; live?: boolean }) {
  return (
    <Badge tone={tone}>
      <StatusDot tone={tone} live={live} />
      {label ?? status}
    </Badge>
  );
}

const statusTone: Record<string, StatusTone> = {
  online: "success", pending: "warning", offline: "danger", degraded: "warning",
  maintenance: "info", error: "danger", unknown: "neutral", active: "success",
  draft: "neutral", deploying: "info", stopped: "neutral", suspended: "warning",
  expired: "warning", revoked: "danger", up: "success", down: "danger",
  planned: "neutral", queued: "neutral", running: "info", success: "success",
  failed: "danger", cancelled: "neutral", rolled_back: "warning", open: "danger",
  acknowledged: "warning", resolved: "success", enrolled: "info", approved: "success",
  not_enrolled: "neutral", suspended_quota: "danger",
};

/** Canonical status pill used by every table, card and detail header. */
export function UnifiedStatus({ status, live }: { status: string; live?: boolean }) {
  const tone = statusTone[status] ?? "neutral";
  return <StatusBadge status={status} tone={tone} label={status.replace(/_/g, " ")} live={live ?? (status === "online" || status === "up")} />;
}

// --------------------------------------------------------------------- Loading

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("shimmer rounded-default", className)} aria-hidden />;
}

/** Skeleton table used while a list query is in flight. */
export function SkeletonRows({ rows = 6, cols = 5, className }: { rows?: number; cols?: number; className?: string }) {
  return (
    <div className={cx("divide-y divide-line/60", className)} aria-busy>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-4 px-3 py-3">
          {Array.from({ length: cols }).map((__, c) => (
            <Skeleton key={c} className={cx("h-3.5", c === 0 ? "w-40" : c === cols - 1 ? "ml-auto w-16" : "w-24")} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 size={15} className={cx("animate-spin text-muted", className)} />;
}

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2.5 py-20 text-[13px] text-muted">
      <Spinner />
      {label}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  message,
  action,
  compact,
}: {
  icon?: ReactNode;
  title: string;
  message?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={cx("relative flex flex-col items-center justify-center px-6 text-center", compact ? "py-10" : "py-16")}>
      <div
        className="pointer-events-none absolute inset-x-0 top-0 mx-auto h-32 w-64 rounded-full opacity-[0.5] blur-3xl"
        style={{ background: "radial-gradient(closest-side, var(--accent-glow), transparent)" }}
        aria-hidden
      />
      {icon && (
        <div className="relative mb-3.5 flex size-11 items-center justify-center rounded-lg border border-line bg-surface-2 text-muted shadow-card">
          {icon}
        </div>
      )}
      <h3 className="relative text-[13px] font-semibold text-text">{title}</h3>
      {message && <p className="relative mt-1.5 max-w-md text-xs leading-relaxed text-muted">{message}</p>}
      {action && <div className="relative mt-4 flex items-center gap-2">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <div className="mb-3.5 flex size-11 items-center justify-center rounded-lg border border-danger/30 bg-danger-soft text-danger">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
        </svg>
      </div>
      <h3 className="text-[13px] font-semibold text-text">Something went wrong</h3>
      <p className="mt-1.5 max-w-md text-xs leading-relaxed text-muted">{message}</p>
      {onRetry && (
        <Button variant="secondary" size="sm" className="mt-4" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------- Meter

export function Meter({
  pct,
  tone = "info",
  label,
  size = "md",
}: {
  pct: number | null;
  tone?: "success" | "warning" | "danger" | "info";
  label?: ReactNode;
  size?: "sm" | "md";
}) {
  const resolved = tone === "info" && pct != null ? (pct > 90 ? "danger" : pct > 70 ? "warning" : "success") : tone;
  const bar = {
    success: "bg-gradient-to-r from-success/70 to-success",
    warning: "bg-gradient-to-r from-warning/70 to-warning",
    danger: "bg-gradient-to-r from-danger/70 to-danger",
    info: "bg-gradient-to-r from-info/70 to-info",
  }[resolved];
  return (
    <div className="w-full">
      {label && (
        <div className="mb-1 flex items-center justify-between text-2xs text-muted">
          <span>{label}</span>
          <span className="mono tnum">{pct != null ? `${pct.toFixed(0)}%` : "—"}</span>
        </div>
      )}
      <div className={cx("w-full overflow-hidden rounded-full bg-surface-3 shadow-inset", size === "sm" ? "h-1" : "h-1.5")}>
        <div
          className={cx("h-full origin-left rounded-full transition-[width] duration-slow ease-out-quint", bar)}
          style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%` }}
        />
      </div>
    </div>
  );
}

// -------------------------------------------------------------------- Sparkline

/** Dependency-free sparkline for metric cards (values are already aggregates). */
export function Sparkline({ values, tone = "accent", className }: { values: number[]; tone?: "accent" | "success" | "info"; className?: string }) {
  if (values.length < 2) return null;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const step = 100 / (values.length - 1);
  const points = values.map((v, i) => `${i * step},${28 - ((v - min) / range) * 26}`).join(" ");
  const stroke = tone === "accent" ? "var(--accent)" : tone === "success" ? "var(--success)" : "var(--info)";
  return (
    <svg viewBox="0 0 100 28" preserveAspectRatio="none" className={cx("h-7 w-full", className)} aria-hidden>
      <polyline points={points} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      <polygon points={`0,28 ${points} 100,28`} fill={stroke} opacity="0.09" />
    </svg>
  );
}

export function Trend({ value, suffix = "%" }: { value: number | null; suffix?: string }) {
  if (value == null) return null;
  const up = value >= 0;
  return (
    <span className={cx("inline-flex items-center gap-1 text-2xs font-medium tnum", up ? "text-success" : "text-danger")}>
      {up ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
      {up ? "+" : ""}
      {value.toFixed(1)}
      {suffix}
    </span>
  );
}

export function Divider({ className, label }: { className?: string; label?: ReactNode }) {
  if (label) {
    return (
      <div className={cx("flex items-center gap-3", className)}>
        <span className="h-px flex-1 bg-line" />
        <span className="label-micro">{label}</span>
        <span className="h-px flex-1 bg-line" />
      </div>
    );
  }
  return <div className={cx("h-px w-full bg-line", className)} />;
}

// ------------------------------------------------------------------------- Kbd

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="mono rounded border border-line bg-surface-3 px-1.5 py-0.5 text-3xs font-medium text-muted shadow-[0_1px_0_rgba(0,0,0,0.4)]">
      {children}
    </kbd>
  );
}

export function KeyValue({ label, value, mono }: { label: ReactNode; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line/60 py-1.5 last:border-0">
      <span className="text-2xs text-faint">{label}</span>
      <span className={cx("min-w-0 truncate text-right text-xs text-text", mono && "mono text-2xs")}>{value}</span>
    </div>
  );
}

// ------------------------------------------------------------------ PageHeader

export function PageHeader({
  title,
  desc,
  actions,
  badge,
  breadcrumb,
  icon,
}: {
  title: ReactNode;
  desc?: ReactNode;
  actions?: ReactNode;
  badge?: ReactNode;
  breadcrumb?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        {breadcrumb && <div className="mb-2">{breadcrumb}</div>}
        <div className="flex items-center gap-2.5">
          {icon && (
            <span className="flex size-8 items-center justify-center rounded-default border border-line bg-surface-2 text-muted">{icon}</span>
          )}
          <h1 className="text-[17px] font-semibold leading-tight tracking-tight text-text">{title}</h1>
          {badge}
        </div>
        {desc && <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted">{desc}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Small back-link used by detail pages (client-side navigation only). */
export function BackLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded text-xs text-muted transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="m15 18-6-6 6-6" />
      </svg>
      {label}
    </button>
  );
}
