import { type ReactNode, useEffect, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as DropdownPrimitive from "@radix-ui/react-dropdown-menu";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { AlertTriangle, X } from "lucide-react";
import { cx, Button, IconButton } from "./primitives";

/* ==========================================================================
   Dialogs & drawers.

   Rule of thumb for the panel:
     * confirmation / short task  -> Dialog (compact, centered)
     * multi-field creation form  -> Drawer (right sheet, keeps page context)
   Both share the same surface, header, footer and motion so they feel related.
   ========================================================================== */

export function Dialog({ open, onOpenChange, children }: { open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode }) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      {children}
    </DialogPrimitive.Root>
  );
}

const dialogSize = {
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-4xl",
} as const;

export function DialogContent({
  title,
  desc,
  children,
  wide,
  size,
  footer,
}: {
  title: ReactNode;
  desc?: ReactNode;
  children: ReactNode;
  /** @deprecated prefer `size`; kept so existing pages keep compiling. */
  wide?: boolean;
  size?: keyof typeof dialogSize;
  footer?: ReactNode;
}) {
  const resolved = size ?? (wide ? "lg" : "md");
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/70 backdrop-blur-xs data-[state=open]:animate-fade-in" />
      <DialogPrimitive.Content
        className={cx(
          "panel-glass fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 shadow-overlay",
          "max-h-[92vh] overflow-hidden data-[state=open]:animate-scale-in",
          dialogSize[resolved],
        )}
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-line bg-surface-glass px-5 pb-3 pt-4 backdrop-blur-md">
          <div className="min-w-0">
            <DialogPrimitive.Title className="text-[13px] font-semibold leading-tight text-text">{title}</DialogPrimitive.Title>
            {desc && (
              <DialogPrimitive.Description className="mt-1 text-2xs leading-snug text-muted">{desc}</DialogPrimitive.Description>
            )}
          </div>
          <DialogPrimitive.Close asChild>
            <IconButton aria-label="Close dialog">
              <X size={15} />
            </IconButton>
          </DialogPrimitive.Close>
        </div>
        <div className="max-h-[calc(92vh-7rem)] overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-line bg-surface-2/50 px-5 py-3">{footer}</div>}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

/** Right-hand sheet for multi-step or multi-field creation flows. */
export function Drawer({
  open,
  onOpenChange,
  title,
  desc,
  children,
  footer,
  width = "max-w-xl",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  desc?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/65 backdrop-blur-xs data-[state=open]:animate-fade-in" />
        <DialogPrimitive.Content
          className={cx(
            "fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-line bg-surface shadow-overlay outline-none",
            "data-[state=open]:animate-slide-in-right",
            width,
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 pb-3.5 pt-4">
            <div className="min-w-0">
              <DialogPrimitive.Title className="text-[13px] font-semibold leading-tight text-text">{title}</DialogPrimitive.Title>
              {desc && (
                <DialogPrimitive.Description className="mt-1 text-2xs leading-snug text-muted">{desc}</DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close asChild>
              <IconButton aria-label="Close panel">
                <X size={15} />
              </IconButton>
            </DialogPrimitive.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line bg-surface-2/50 px-5 py-3">{footer}</div>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  message,
  confirmLabel = "Confirm",
  danger,
  onConfirm,
  loading,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  loading?: boolean;
  children?: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={title} size="sm">
        {danger ? (
          <div className="flex items-start gap-2.5 rounded-default border border-danger/25 bg-danger-soft px-3 py-2.5">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-danger" />
            <div className="text-xs leading-relaxed text-text">{message}</div>
          </div>
        ) : (
          <div className="mb-3 text-xs leading-relaxed text-muted">{message}</div>
        )}
        {children && <div className="mt-3">{children}</div>}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ========================================================================== */
/* Dropdown menu                                                              */
/* ========================================================================== */

export const DropdownMenu = DropdownPrimitive.Root;
export const DropdownTrigger = DropdownPrimitive.Trigger;

export function DropdownContent({ children, align = "end" }: { children: ReactNode; align?: "start" | "end" | "center" }) {
  return (
    <DropdownPrimitive.Portal>
      <DropdownPrimitive.Content
        align={align}
        sideOffset={6}
        collisionPadding={8}
        className="panel-glass z-50 min-w-44 p-1 shadow-overlay data-[state=open]:animate-scale-in"
      >
        {children}
      </DropdownPrimitive.Content>
    </DropdownPrimitive.Portal>
  );
}

export function DropdownItem({
  children,
  onSelect,
  danger,
  disabled,
}: {
  children: ReactNode;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <DropdownPrimitive.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cx(
        "flex cursor-pointer select-none items-center gap-2 rounded px-2.5 py-1.5 text-xs outline-none transition-colors duration-fast",
        danger ? "text-danger data-[highlighted]:bg-danger-soft" : "text-text data-[highlighted]:bg-surface-3",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-40",
      )}
    >
      {children}
    </DropdownPrimitive.Item>
  );
}

export function DropdownSeparator() {
  return <DropdownPrimitive.Separator className="my-1 h-px bg-line" />;
}

export function DropdownLabel({ children }: { children: ReactNode }) {
  return <DropdownPrimitive.Label className="label-micro px-2.5 py-1.5">{children}</DropdownPrimitive.Label>;
}

/* ========================================================================== */
/* Tooltip                                                                    */
/* ========================================================================== */

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <TooltipPrimitive.Provider delayDuration={200}>{children}</TooltipPrimitive.Provider>;
}

export function Tooltip({ content, children, side = "top" }: { content: ReactNode; children: ReactNode; side?: "top" | "right" | "bottom" | "left" }) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={8}
          className="z-50 max-w-72 rounded-default border border-line bg-surface-2/95 px-2.5 py-1.5 text-2xs text-text shadow-overlay backdrop-blur-md data-[state=delayed-open]:animate-fade-in"
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

/* ========================================================================== */
/* Tabs — underline (detail pages) and segmented (view switchers)             */
/* ========================================================================== */

export function Tabs({
  value,
  onValueChange,
  items,
  variant = "underline",
}: {
  value?: string;
  onValueChange?: (v: string) => void;
  items: Array<{ value: string; label: ReactNode; content: ReactNode; count?: number }>;
  variant?: "underline" | "segmented";
}) {
  const [internal, setInternal] = useState(items[0]?.value ?? "");
  const current = value ?? internal;
  const change = (v: string) => {
    setInternal(v);
    onValueChange?.(v);
  };
  return (
    <TabsPrimitive.Root value={current} onValueChange={change}>
      <TabsPrimitive.List
        className={cx(
          variant === "underline"
            ? "mb-4 flex gap-0.5 overflow-x-auto border-b border-line"
            : "mb-4 inline-flex gap-1 rounded-default border border-line bg-surface-2 p-1",
        )}
      >
        {items.map((item) => (
          <TabsPrimitive.Trigger
            key={item.value}
            value={item.value}
            className={cx(
              "inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium transition-colors duration-fast ease-arvoo",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
              variant === "underline"
                ? "relative -mb-px rounded-t px-3 py-2 text-muted hover:text-text data-[state=active]:text-text data-[state=active]:after:absolute data-[state=active]:after:inset-x-2 data-[state=active]:after:-bottom-px data-[state=active]:after:h-[2px] data-[state=active]:after:rounded-full data-[state=active]:after:bg-accent"
                : "rounded-[6px] px-2.5 py-1 text-muted hover:text-text data-[state=active]:bg-surface-3 data-[state=active]:text-text data-[state=active]:shadow-[0_1px_0_rgba(255,255,255,0.04)_inset]",
            )}
          >
            {item.label}
            {item.count != null && (
              <span className="mono rounded-full bg-surface-3 px-1.5 text-3xs text-faint tnum">{item.count}</span>
            )}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
      {items.map((item) => (
        <TabsPrimitive.Content key={item.value} value={item.value} className="outline-none data-[state=active]:animate-fade-in">
          {item.content}
        </TabsPrimitive.Content>
      ))}
    </TabsPrimitive.Root>
  );
}

/** Lock body scroll while a modal is open (radix handles most cases). */
export function useModalGuard(open: boolean) {
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);
}
