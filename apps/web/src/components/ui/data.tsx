import { type ReactNode, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Check, ChevronLeft, ChevronRight, ChevronsUpDown, Copy, Inbox } from "lucide-react";
import { cx, Button, Checkbox, EmptyState, SkeletonRows, Sparkline } from "./primitives";

/* ==========================================================================
   DataTable — one table system for the whole panel.

   * desktop: hairline rows, hover highlight, sticky translucent header
   * tablet:  columns flagged `hideBelow` drop out first
   * mobile:  the same data renders as stacked cards (no horizontal scrolling
     for the primary content of a row)
   * every list gets sorting, pagination, loading, empty and error states from
     this one component, so tables cannot drift apart visually.
   ========================================================================== */

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  /** Enables sorting when provided. */
  sortValue?: (row: T) => string | number;
  /** Align numeric/right-hand content. */
  align?: "left" | "right" | "center";
  className?: string;
  /** Column is dropped below this breakpoint (tablet behaviour). */
  hideBelow?: "sm" | "md" | "lg";
  /** Used as the card title on mobile; the first column is used by default. */
  primary?: boolean;
  /** Excluded from the mobile card layout (e.g. actions). */
  mobileHidden?: boolean;
}

export interface DataTableProps<T> {
  columns: Array<Column<T>>;
  rows: T[];
  rowKey: (row: T) => string;
  empty?: ReactNode;
  onRowClick?: (row: T) => void;
  pageSize?: number;
  initialSort?: { key: string; dir: "asc" | "desc" };
  loading?: boolean;
  dense?: boolean;
  /** Rendered above the table (search, filters, actions). */
  toolbar?: ReactNode;
  /** Row-level action cluster, right aligned. */
  rowActions?: (row: T) => ReactNode;
  stickyHeader?: boolean;
  footerNote?: ReactNode;
  /** Enables row selection; pair with `selected` + `onSelectionChange`. */
  selectable?: boolean;
  selected?: string[];
  onSelectionChange?: (keys: string[]) => void;
}

const hideBelowClass: Record<"sm" | "md" | "lg", string> = {
  sm: "max-sm:hidden",
  md: "max-md:hidden",
  lg: "max-lg:hidden",
};

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  empty,
  onRowClick,
  pageSize = 25,
  initialSort,
  loading,
  dense,
  toolbar,
  rowActions,
  stickyHeader = true,
  footerNote,
  selectable,
  selected = [],
  onSelectionChange,
}: DataTableProps<T>) {
  const [sort, setSort] = useState(initialSort ?? null);
  const [page, setPage] = useState(0);

  const sorted = useMemo(() => {
    const copy = [...rows];
    if (!sort) return copy;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return copy;
    return copy.sort((a, b) => {
      const va = col.sortValue!(a);
      const vb = col.sortValue!(b);
      const cmp = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb));
      return sort.dir === "asc" ? cmp : -cmp;
    });
  }, [rows, sort, columns]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const visible = sorted.slice(safePage * pageSize, safePage * pageSize + pageSize);

  const toggleSort = (key: string) =>
    setSort((s) => (s?.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));

  if (loading) {
    return (
      <div className="panel overflow-hidden">
        {toolbar && <div className="border-b border-line px-3 py-2.5">{toolbar}</div>}
        <SkeletonRows rows={Math.min(pageSize, 7)} cols={Math.min(columns.length, 6)} />
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="panel overflow-hidden">
        {toolbar && <div className="border-b border-line px-3 py-2.5">{toolbar}</div>}
        {empty ?? (
          <EmptyState
            icon={<Inbox size={18} />}
            title="Nothing here yet"
            message="Records appear here as soon as this part of the infrastructure reports in."
          />
        )}
      </div>
    );
  }

  const selectedSet = new Set(selected);
  const toggleRow = (key: string, on: boolean) =>
    onSelectionChange?.(on ? [...selected, key] : selected.filter((k) => k !== key));
  const visibleKeys = visible.map(rowKey);
  const allVisibleSelected = visibleKeys.length > 0 && visibleKeys.every((k) => selectedSet.has(k));
  const someVisibleSelected = visibleKeys.some((k) => selectedSet.has(k));

  const primaryColumn = columns.find((c) => c.primary) ?? columns[0];
  const mobileColumns = columns.filter((c) => c !== primaryColumn && !c.mobileHidden);
  const cellPad = dense ? "px-3 py-1.5" : "px-3 py-2.5";
  const align = (a?: Column<T>["align"]) => (a === "right" ? "text-right" : a === "center" ? "text-center" : "text-left");

  return (
    <div className="panel overflow-hidden">
      {toolbar && <div className="border-b border-line px-3 py-2.5">{toolbar}</div>}

      {/* ---------------- Desktop / tablet table ---------------- */}
      <div className="max-md:hidden">
        <div className={cx("overflow-x-auto", stickyHeader && "max-h-[70vh] overflow-y-auto")}>
          <table className="w-full border-separate border-spacing-0 text-[13px]">
            <thead>
              <tr className="text-2xs uppercase tracking-wider text-faint">
                {selectable && (
                  <th className="sticky top-0 z-10 w-9 border-b border-line bg-surface-glass px-3 py-2 backdrop-blur-md">
                    <Checkbox
                      label="Select all visible rows"
                      checked={allVisibleSelected}
                      indeterminate={someVisibleSelected && !allVisibleSelected}
                      onCheckedChange={(on) => {
                        const next = new Set(selected);
                        for (const k of visibleKeys) on ? next.add(k) : next.delete(k);
                        onSelectionChange?.(Array.from(next));
                      }}
                    />
                  </th>
                )}
                {columns.map((col) => (
                  <th
                    key={col.key}
                    scope="col"
                    className={cx(
                      "whitespace-nowrap border-b border-line px-3 py-2 font-medium",
                      "sticky top-0 z-10 bg-surface-glass backdrop-blur-md",
                      col.hideBelow && hideBelowClass[col.hideBelow],
                      align(col.align),
                      col.className,
                    )}
                  >
                    {col.sortValue ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(col.key)}
                        className={cx(
                          "inline-flex items-center gap-1 rounded transition-colors hover:text-text",
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
                          sort?.key === col.key && "text-text",
                        )}
                        aria-label={`Sort by ${typeof col.header === "string" ? col.header : col.key}`}
                      >
                        {col.header}
                        {sort?.key === col.key ? (
                          sort.dir === "asc" ? (
                            <ArrowUp size={11} className="text-accent" />
                          ) : (
                            <ArrowDown size={11} className="text-accent" />
                          )
                        ) : (
                          <ChevronsUpDown size={11} className="opacity-50" />
                        )}
                      </button>
                    ) : (
                      col.header
                    )}
                  </th>
                ))}
                {rowActions && <th className="sticky top-0 z-10 border-b border-line bg-surface-glass px-3 py-2" />}
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr
                  key={rowKey(row)}
                  onClick={() => onRowClick?.(row)}
                  className={cx(
                    "group/row transition-colors duration-fast",
                    onRowClick && "cursor-pointer",
                    selectedSet.has(rowKey(row)) ? "bg-accent-soft" : "hover:bg-surface-2",
                  )}
                >
                  {selectable && (
                    <td className={cx(cellPad, "border-b border-line/50 align-middle")}>
                      <Checkbox
                        label={`Select ${rowKey(row)}`}
                        checked={selectedSet.has(rowKey(row))}
                        onCheckedChange={(on) => toggleRow(rowKey(row), on)}
                      />
                    </td>
                  )}
                  {columns.map((col, i) => (
                    <td
                      key={col.key}
                      className={cx(
                        cellPad,
                        "border-b border-line/50 align-middle text-text",
                        col.hideBelow && hideBelowClass[col.hideBelow],
                        align(col.align),
                        i === 0 &&
                          "relative before:absolute before:inset-y-0 before:left-0 before:w-px before:bg-accent before:opacity-0 before:transition-opacity before:duration-fast group-hover/row:before:opacity-100",
                        col.className,
                      )}
                    >
                      {col.render(row)}
                    </td>
                  ))}
                  {rowActions && (
                    <td
                      className={cx(cellPad, "border-b border-line/50 text-right")}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="flex items-center justify-end gap-1 opacity-70 transition-opacity group-hover/row:opacity-100">
                        {rowActions(row)}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ---------------- Mobile cards ---------------- */}
      <div className="divide-y divide-line/60 md:hidden">
        {visible.map((row) => (
          <div
            key={rowKey(row)}
            onClick={() => onRowClick?.(row)}
            className={cx(
              "px-3 py-2.5",
              onRowClick && "cursor-pointer active:bg-surface-2",
              selectedSet.has(rowKey(row)) && "bg-accent-soft",
            )}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex min-w-0 items-start gap-2.5">
                {selectable && (
                  <Checkbox
                    className="mt-0.5"
                    label={`Select ${rowKey(row)}`}
                    checked={selectedSet.has(rowKey(row))}
                    onCheckedChange={(on) => toggleRow(rowKey(row), on)}
                  />
                )}
                <div className="min-w-0 text-[13px] font-medium text-text">{primaryColumn?.render(row)}</div>
              </div>
              {rowActions && <div className="flex shrink-0 items-center gap-1">{rowActions(row)}</div>}
            </div>
            <div className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              {mobileColumns.map((col) => (
                <div key={col.key} className="contents">
                  <span className="text-2xs text-faint">{col.header}</span>
                  <span className="min-w-0 text-right text-2xs text-muted">{col.render(row)}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* ---------------- Footer ---------------- */}
      {(pageCount > 1 || footerNote) && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-3 py-2 text-2xs text-muted">
          <span className="tnum">
            {footerNote ?? (
              <>
                {safePage * pageSize + 1}–{Math.min(sorted.length, (safePage + 1) * pageSize)} of {sorted.length}
              </>
            )}
          </span>
          {pageCount > 1 && (
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                disabled={safePage === 0}
                onClick={() => setPage(safePage - 1)}
                aria-label="Previous page"
              >
                <ChevronLeft size={13} />
              </Button>
              <span className="px-1.5 tnum">
                {safePage + 1} / {pageCount}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={safePage >= pageCount - 1}
                onClick={() => setPage(safePage + 1)}
                aria-label="Next page"
              >
                <ChevronRight size={13} />
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ==========================================================================
   StatCard — the metric unit of the dashboard.
   Value is the loudest element, label is a micro-caption, and the optional
   sparkline/trend/hint rows only render when data actually exists.
   ========================================================================== */

export function StatCard({
  label,
  value,
  sub,
  tone,
  icon,
  sparkline,
  trend,
  onClick,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "default" | "success" | "warning" | "danger" | "accent";
  icon?: ReactNode;
  sparkline?: number[];
  trend?: ReactNode;
  onClick?: () => void;
}) {
  const valueTone = {
    default: "text-text",
    success: "text-success",
    warning: "text-warning",
    danger: "text-danger",
    accent: "text-accent",
  }[tone ?? "default"];

  return (
    <div
      className={cx(
        "group/stat relative overflow-hidden rounded-default border border-line bg-surface px-3.5 py-3 transition-[border-color,background-color,transform] duration-fast ease-arvoo",
        onClick && "cursor-pointer hover:border-line-strong hover:bg-surface-2",
      )}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => (e.key === "Enter" || e.key === " ") && onClick() : undefined}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="label-micro">{label}</span>
        {icon && <span className="text-faint transition-colors group-hover/stat:text-muted">{icon}</span>}
      </div>
      <div className="mt-1.5 flex items-end justify-between gap-2">
        <div className={cx("text-[22px] font-semibold leading-none tracking-tight tnum", valueTone)}>{value}</div>
        {trend}
      </div>
      {sparkline && sparkline.length > 1 && <div className="mt-2 -mb-1 opacity-80">{<Sparkline values={sparkline} />}</div>}
      {sub && <div className="mt-1.5 text-2xs leading-snug text-muted">{sub}</div>}
    </div>
  );
}

/* ==========================================================================
   CodeBlock — generated configs, keys and command output.
   ========================================================================== */

export function CodeBlock({
  code,
  maxHeight = "400px",
  filename,
  language,
}: {
  code: string;
  maxHeight?: string;
  filename?: string;
  language?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="inset overflow-hidden">
      <div className="flex items-center justify-between border-b border-line/80 bg-surface-2/70 px-2.5 py-1.5">
        <span className="mono flex items-center gap-2 text-2xs text-faint">
          <span className="flex gap-1" aria-hidden>
            <span className="size-1.5 rounded-full bg-line-strong" />
            <span className="size-1.5 rounded-full bg-line-strong" />
            <span className="size-1.5 rounded-full bg-line-strong" />
          </span>
          {filename ?? "config"}
          {language && <span className="text-faint/70">· {language}</span>}
        </span>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded text-2xs text-muted transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          onClick={() => {
            void navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="mono overflow-auto bg-surface-inset p-3 text-2xs leading-relaxed text-text/90" style={{ maxHeight }}>
        {code}
      </pre>
    </div>
  );
}

export { EmptyState };
