import { useCallback, useEffect, useState, type ReactNode } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import {
  Activity, Boxes, ChevronLeft, Flame, Gauge, Globe, LayoutDashboard, LogOut, Menu, Moon, Network, Route,
  Scale, ScrollText, Search, Server, Settings2, ShieldCheck, Sun, TriangleAlert, Users,
} from "lucide-react";
import { api } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { timeAgo } from "../../lib/format";
import { cx, Badge, Kbd, StatusDot } from "../ui/primitives";
import { DropdownMenu, DropdownTrigger, DropdownContent, DropdownItem, DropdownSeparator, DropdownLabel, Tooltip } from "../ui/overlay";
import { CommandPalette } from "./CommandPalette";

function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem("arvoo.theme") as "light" | "dark" | null;
    const prefersLight = window.matchMedia("(prefers-color-scheme: light)").matches;
    const resolved = stored ?? (prefersLight ? "light" : "dark");
    document.documentElement.setAttribute("data-theme", resolved);
    setTheme(resolved);
  }, []);

  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next = prev === "light" ? "dark" : "light";
      document.documentElement.setAttribute("data-theme", next);
      localStorage.setItem("arvoo.theme", next);
      return next;
    });
  }, []);

  return { theme, toggle };
}

interface NavItem {
  to: string;
  icon: ReactNode;
  label: string;
  end?: boolean;
}

interface SidebarSection {
  label: string;
  items: NavItem[];
}

/**
 * Navigation mirrors the control plane's real domains: what the panel *does*
 * (VPN), what it *runs on* (Infrastructure), and everything that is history or
 * configuration. Section labels are micro-typography so they never compete with
 * the items themselves.
 */
function buildSections(t: (key: string) => string): SidebarSection[] {
  return [
    {
      label: t("nav.overview"),
      items: [
        { to: "/", icon: <LayoutDashboard size={15} />, label: t("nav.dashboard"), end: true },
        { to: "/alerts", icon: <TriangleAlert size={15} />, label: t("nav.alerts") },
        { to: "/activity", icon: <Activity size={15} />, label: t("nav.activity") },
      ],
    },
    {
      label: "VPN",
      items: [
        { to: "/inbounds", icon: <Globe size={15} />, label: t("nav.inbounds") },
        { to: "/clients", icon: <Users size={15} />, label: t("nav.clients") },
        { to: "/load-balancing", icon: <Scale size={15} />, label: t("nav.loadbalancing") },
        { to: "/policies", icon: <ShieldCheck size={15} />, label: t("nav.policies") },
      ],
    },
    {
      label: t("nav.infrastructure"),
      items: [
        { to: "/nodes", icon: <Server size={15} />, label: t("nav.nodes") },
        { to: "/tunnels", icon: <Network size={15} />, label: t("nav.tunnels") },
        { to: "/topology", icon: <Route size={15} />, label: t("nav.topology") },
        { to: "/routing", icon: <Gauge size={15} />, label: t("nav.routing") },
      ],
    },
    {
      label: t("nav.ops"),
      items: [
        { to: "/operations", icon: <Boxes size={15} />, label: t("nav.operations") },
        { to: "/audit", icon: <ScrollText size={15} />, label: t("nav.audit") },
      ],
    },
    {
      label: t("nav.settings"),
      items: [
        { to: "/firewall", icon: <Flame size={15} />, label: t("nav.firewall") },
        { to: "/settings", icon: <Settings2 size={15} />, label: t("nav.settings") },
      ],
    },
  ];
}

interface Me {
  user: { id: string; username: string; role: string };
}

export function AppShell() {
  const navigate = useNavigate();
  const { t, lang, setLang } = useI18n();
  const sections = buildSections(t);
  const [me, setMe] = useState<Me | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("arvoo.sidebar") === "collapsed");

  useEffect(() => {
    api.get<Me>("/auth/me").then(setMe).catch(() => undefined);
  }, []);

  useEffect(() => {
    localStorage.setItem("arvoo.sidebar", collapsed ? "collapsed" : "expanded");
  }, [collapsed]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const logout = useCallback(async () => {
    await api.post("/auth/logout").catch(() => undefined);
    navigate("/login");
  }, [navigate]);

  const { theme, toggle: toggleTheme } = useTheme();

  return (
    <div className="flex h-full overflow-hidden">
      {/* ---------------------------------------------------------- Sidebar */}
      <aside
        className={cx(
          "z-30 flex shrink-0 flex-col border-r border-line bg-bg-elevated/95 transition-[width,transform] duration-slow ease-arvoo",
          collapsed ? "w-sidebar-collapsed" : "w-sidebar",
          "max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:w-sidebar max-lg:shadow-overlay max-lg:transition-transform",
          drawerOpen ? "max-lg:translate-x-0" : "max-lg:-translate-x-full",
        )}
        aria-label="Primary"
      >
        {/* Brand */}
        <div className={cx("flex h-topbar shrink-0 items-center gap-2.5 border-b border-line px-3.5", collapsed && "lg:justify-center lg:px-0")}>
          <span className="relative flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-[9px] bg-gradient-to-b from-accent to-[#c03236] text-[13px] font-bold text-white shadow-[0_1px_0_rgba(255,255,255,0.25)_inset,0_6px_16px_-8px_var(--accent-glow)]">
            A
          </span>
          {!collapsed && (
            <div className="min-w-0 leading-none">
              <div className="text-[13px] font-semibold tracking-[0.14em] text-text">ARVOO</div>
              <div className="mt-1 text-3xs font-medium uppercase tracking-[0.16em] text-faint">{t("nav.controlPlane")}</div>
            </div>
          )}
        </div>

        {/* Navigation */}
        <nav className="min-h-0 flex-1 space-y-5 overflow-y-auto overflow-x-hidden px-2.5 py-3.5">
          {sections.map((section) => (
            <div key={section.label}>
              {!collapsed && <div className="label-micro mb-1.5 px-2.5">{section.label}</div>}
              {collapsed && <div className="mx-auto mb-2 h-px w-6 bg-line" aria-hidden />}
              <div className="space-y-0.5">
                {section.items.map((item) => (
                  <NavItemLink
                    key={item.to}
                    item={item}
                    collapsed={collapsed}
                    onNavigate={() => setDrawerOpen(false)}
                  />
                ))}
              </div>
            </div>
          ))}
        </nav>

        {/* Footer: collapse control (desktop) */}
        <div className={cx("hidden shrink-0 border-t border-line p-2 lg:block", collapsed && "flex justify-center")}>
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className={cx(
              "flex h-8 items-center gap-2 rounded-[7px] px-2.5 text-2xs text-faint transition-colors duration-fast hover:bg-surface-2 hover:text-text",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
              collapsed && "w-8 justify-center px-0",
            )}
          >
            <ChevronLeft size={14} className={cx("transition-transform duration-slow ease-arvoo", collapsed && "rotate-180")} />
            {!collapsed && "Collapse"}
          </button>
        </div>
      </aside>

      {drawerOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/70 backdrop-blur-xs lg:hidden"
          onClick={() => setDrawerOpen(false)}
          aria-hidden
        />
      )}

      {/* ------------------------------------------------------------- Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-topbar shrink-0 items-center gap-3 border-b border-line bg-surface-glass px-3 backdrop-blur-md lg:px-5">
          <button
            type="button"
            className="flex size-8 items-center justify-center rounded-default text-muted transition-colors hover:bg-surface-2 hover:text-text lg:hidden"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open navigation"
          >
            <Menu size={17} />
          </button>

          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className={cx(
              "group flex h-8 w-full max-w-md items-center gap-2 rounded-default border border-line bg-surface-2/70 px-2.5 text-xs text-faint",
              "transition-[border-color,background-color] duration-fast hover:border-line-strong hover:bg-surface-2 hover:text-muted",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
            )}
          >
            <Search size={13} />
            <span className="flex-1 truncate text-left">Search or jump to…</span>
            <Kbd>
              <span className="hidden sm:inline">Ctrl </span>K
            </Kbd>
          </button>

          <div className="ml-auto flex shrink-0 items-center gap-2">
            <HeartbeatChip />
            {me && (
              <DropdownMenu>
                <DropdownTrigger asChild>
                  <button
                    type="button"
                    className="flex h-8 items-center gap-2 rounded-default border border-transparent px-1.5 transition-colors duration-fast hover:border-line hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                    aria-label="Account menu"
                  >
                    <span className="flex size-6 items-center justify-center rounded-full bg-surface-3 text-2xs font-semibold uppercase text-muted">
                      {me.user.username.slice(0, 1)}
                    </span>
                    <span className="hidden text-left leading-none sm:block">
                      <span className="block text-2xs font-medium text-text">{me.user.username}</span>
                      <span className="mt-0.5 block text-3xs capitalize text-faint">{me.user.role}</span>
                    </span>
                  </button>
                </DropdownTrigger>
              <DropdownContent>
                <DropdownLabel>Signed in</DropdownLabel>
                <div className="px-2.5 pb-2">
                  <div className="text-xs font-medium text-text">{me.user.username}</div>
                  <div className="text-2xs capitalize text-faint">{me.user.role} access</div>
                </div>
                <DropdownSeparator />
                <DropdownItem onSelect={() => navigate("/settings")}>
                  <Settings2 size={13} /> Settings
                </DropdownItem>
                <DropdownSeparator />
                <DropdownItem onSelect={toggleTheme}>
                  {theme === "light" ? (
                    <>
                      <Moon size={13} className="shrink-0" />
                      Switch to dark
                    </>
                  ) : (
                    <>
                      <Sun size={13} className="shrink-0" />
                      Switch to light
                    </>
                  )}
                </DropdownItem>
                <DropdownItem onSelect={() => setLang(lang === "fa" ? "en" : "fa")}>
                  <Globe size={13} className="shrink-0" />
                  {lang === "fa" ? "English" : "فارسی"}
                </DropdownItem>
                <DropdownSeparator />
                <DropdownItem danger onSelect={logout}>
                  <LogOut size={13} /> {t("nav.signOut")}
                </DropdownItem>
              </DropdownContent>
              </DropdownMenu>
            )}
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[1560px] px-4 py-5 lg:px-6 lg:py-6">
            <Outlet />
          </div>
        </main>
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}

function NavItemLink({ item, collapsed, onNavigate }: { item: NavItem; collapsed: boolean; onNavigate: () => void }) {
  const link = (
    <NavLink
      to={item.to}
      end={item.end}
      onClick={onNavigate}
      className={({ isActive }) =>
        cx(
          "group relative flex h-8 items-center gap-2.5 rounded-[7px] px-2.5 text-[12.5px] transition-colors duration-fast ease-arvoo",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
          collapsed && "lg:justify-center lg:px-0",
          isActive
            ? "bg-accent-soft font-medium text-text"
            : "font-normal text-muted hover:bg-surface-2 hover:text-text",
        )
      }
    >
      {({ isActive }) => (
        <>
          <span
            className={cx(
              "absolute left-0 top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-full bg-accent transition-opacity duration-fast",
              isActive ? "opacity-100" : "opacity-0",
            )}
            aria-hidden
          />
          <span className={cx("shrink-0 transition-colors", isActive ? "text-accent" : "text-faint group-hover:text-muted")}>
            {item.icon}
          </span>
          {!collapsed && <span className="truncate">{item.label}</span>}
        </>
      )}
    </NavLink>
  );

  if (!collapsed) return link;
  return (
    <Tooltip content={item.label} side="right">
      {link}
    </Tooltip>
  );
}

/** Live infrastructure pulse in the topbar — reads the same stats as the dashboard. */
function HeartbeatChip() {
  const [stats, setStats] = useState<import("@arvoo/shared").DashboardStats | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .get<{ stats: import("@arvoo/shared").DashboardStats }>("/dashboard")
        .then((d) => {
          if (!alive) return;
          setStats(d.stats);
          setFailed(false);
        })
        .catch(() => alive && setFailed(true));
    load();
    const t = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (failed) {
    return (
      <Badge tone="danger" className="hidden md:inline-flex">
        <StatusDot tone="danger" />
        API unreachable
      </Badge>
    );
  }
  if (!stats) {
    return <div className="hidden h-5 w-32 shimmer rounded-full md:block" aria-hidden />;
  }

  const nodesHealthy = stats.nodes.total > 0 && stats.nodes.online === stats.nodes.total;
  const tunnelsDown = stats.tunnels.down > 0;
  const tone = tunnelsDown ? "danger" : nodesHealthy ? "success" : "warning";

  return (
    <Tooltip
      content={
        <div className="space-y-0.5">
          <div>{stats.nodes.online}/{stats.nodes.total} nodes online · {stats.nodes.pending} pending</div>
          <div>{stats.tunnels.up}/{stats.tunnels.total} tunnels up · {stats.tunnels.degraded} degraded</div>
        </div>
      }
    >
      <span className="hidden md:inline-flex">
        <Badge tone={tone}>
          <StatusDot tone={tone} live={tone === "success"} />
          {stats.nodes.online}/{stats.nodes.total} nodes
        </Badge>
      </span>
    </Tooltip>
  );
}

export { timeAgo };
