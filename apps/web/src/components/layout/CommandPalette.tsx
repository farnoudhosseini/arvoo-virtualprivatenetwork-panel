import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  ArrowRight, Boxes, CornerDownLeft, Globe, LayoutDashboard, Network, Plus, Route,
  ScrollText, Search, Server, Settings2, ShieldCheck, TriangleAlert, Users, Activity,
} from "lucide-react";
import { cx, Kbd } from "../ui/primitives";

interface Command {
  id: string;
  label: string;
  group: "Navigate" | "Create" | "System";
  icon: React.ReactNode;
  hint?: string;
  keywords?: string;
  action: () => void;
}

/**
 * Command palette (Ctrl/⌘ + K).
 *
 * The list is static because the panel's navigation is static — the search box
 * is a ranking filter over commands, not a server query, so it stays instant.
 */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
    }
  }, [open]);

  const commands: Command[] = useMemo(() => {
    const go = (to: string) => () => {
      onOpenChange(false);
      navigate(to);
    };
    return [
      { id: "dash", label: "Dashboard", group: "Navigate", icon: <LayoutDashboard size={14} />, action: go("/") },
      { id: "nodes", label: "Nodes", group: "Navigate", icon: <Server size={14} />, keywords: "servers agents", action: go("/nodes") },
      { id: "inbounds", label: "Inbounds", group: "Navigate", icon: <Globe size={14} />, keywords: "openvpn vpn", action: go("/inbounds") },
      { id: "clients", label: "Clients", group: "Navigate", icon: <Users size={14} />, keywords: "users peers configs", action: go("/clients") },
      { id: "tunnels", label: "Tunnels", group: "Navigate", icon: <Network size={14} />, keywords: "gre links", action: go("/tunnels") },
      { id: "policies", label: "Policies", group: "Navigate", icon: <ShieldCheck size={14} />, keywords: "rules quota", action: go("/policies") },
      { id: "topology", label: "Network topology", group: "Navigate", icon: <Route size={14} />, action: go("/topology") },
      { id: "operations", label: "Operations", group: "Navigate", icon: <Boxes size={14} />, keywords: "deploy jobs", action: go("/operations") },
      { id: "audit", label: "Audit log", group: "Navigate", icon: <ScrollText size={14} />, keywords: "history", action: go("/audit") },
      { id: "alerts", label: "Alerts", group: "Navigate", icon: <TriangleAlert size={14} />, keywords: "incidents warnings", action: go("/alerts") },
      { id: "activity", label: "Activity", group: "Navigate", icon: <Activity size={14} />, action: go("/activity") },
      { id: "settings", label: "Settings", group: "Navigate", icon: <Settings2 size={14} />, keywords: "configuration", action: go("/settings") },

      { id: "node-new", label: "Create node", group: "Create", icon: <Plus size={14} />, hint: "Infrastructure", keywords: "add server agent enroll", action: go("/nodes?new=1") },
      { id: "tunnel-new", label: "Create GRE tunnel", group: "Create", icon: <Plus size={14} />, hint: "Infrastructure", keywords: "add link", action: go("/tunnels?new=1") },
      { id: "inbound-new", label: "Create OpenVPN inbound", group: "Create", icon: <Plus size={14} />, hint: "VPN", keywords: "add listener endpoint", action: go("/inbounds/new") },
      { id: "client-new", label: "Create client", group: "Create", icon: <Plus size={14} />, hint: "VPN", keywords: "add peer user download profile", action: go("/clients?new=1") },
    ];
  }, [navigate, onOpenChange]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => `${c.label} ${c.group} ${c.hint ?? ""} ${c.keywords ?? ""}`.toLowerCase().includes(q));
  }, [commands, query]);

  useEffect(() => setIndex(0), [query]);

  const groups: Array<Command["group"]> = ["Navigate", "Create", "System"];
  const flat = groups.flatMap((g) => filtered.filter((c) => c.group === g));

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const run = (cmd?: Command) => {
    if (!cmd) return;
    onOpenChange(false);
    cmd.action();
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/70 backdrop-blur-xs data-[state=open]:animate-fade-in" />
        <DialogPrimitive.Content
          aria-label="Command palette"
          className="panel-glass fixed left-1/2 top-[10vh] z-50 w-[min(94vw,620px)] -translate-x-1/2 overflow-hidden shadow-overlay data-[state=open]:animate-scale-in"
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => (i + 1) % Math.max(1, flat.length));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => (i - 1 + flat.length) % Math.max(1, flat.length));
            } else if (e.key === "Enter") {
              e.preventDefault();
              run(flat[index]);
            }
          }}
        >
          <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
          <div className="flex items-center gap-2.5 border-b border-line px-3.5">
            <Search size={15} className="shrink-0 text-faint" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search commands, pages and actions…"
              aria-label="Search commands"
              className="h-11 flex-1 bg-transparent text-[13px] text-text outline-none placeholder:text-faint"
            />
            <Kbd>esc</Kbd>
          </div>

          <div ref={listRef} className="max-h-[54vh] overflow-y-auto p-1.5">
            {flat.length === 0 && (
              <p className="px-3 py-8 text-center text-xs text-faint">No commands match “{query}”.</p>
            )}
            {groups.map((group) => {
              const items = filtered.filter((c) => c.group === group);
              if (items.length === 0) return null;
              return (
                <div key={group} className="mb-1 last:mb-0">
                  <div className="label-micro px-2.5 py-1.5">{group}</div>
                  {items.map((c) => {
                    const i = flat.indexOf(c);
                    const active = i === index;
                    return (
                      <button
                        key={c.id}
                        type="button"
                        data-idx={i}
                        onMouseEnter={() => setIndex(i)}
                        onClick={() => run(c)}
                        className={cx(
                          "relative flex w-full items-center gap-2.5 rounded-[7px] px-2.5 py-2 text-left text-[12.5px] transition-colors duration-fast",
                          active ? "bg-surface-3 text-text" : "text-muted hover:bg-surface-2 hover:text-text",
                        )}
                      >
                        <span
                          className={cx(
                            "absolute left-0 top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-full bg-accent transition-opacity duration-fast",
                            active ? "opacity-100" : "opacity-0",
                          )}
                          aria-hidden
                        />
                        <span className={cx("shrink-0", active ? "text-accent" : "text-faint")}>{c.icon}</span>
                        <span className="min-w-0 flex-1 truncate">{c.label}</span>
                        {c.hint && <span className="shrink-0 text-3xs uppercase tracking-wider text-faint">{c.hint}</span>}
                        {active && <CornerDownLeft size={12} className="shrink-0 text-faint" />}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>

          <div className="flex items-center justify-between border-t border-line px-3.5 py-2 text-3xs text-faint">
            <span className="flex items-center gap-3">
              <span className="flex items-center gap-1">
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd> navigate
              </span>
              <span className="flex items-center gap-1">
                <Kbd>⏎</Kbd> select
              </span>
            </span>
            <span className="flex items-center gap-1">
              <ArrowRight size={10} /> Arvoo control plane
            </span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
