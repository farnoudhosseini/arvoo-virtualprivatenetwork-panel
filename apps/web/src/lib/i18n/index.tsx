/**
 * Lightweight EN/FA i18n for the Arvoo control plane UI.
 * Language is stored in localStorage (`arvoo.lang`) and drives `dir` + `lang` on <html>.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type Lang = "en" | "fa";

const STORAGE_KEY = "arvoo.lang";

/** Flat dictionary of UI strings. Keys are stable English identifiers. */
export const messages: Record<Lang, Record<string, string>> = {
  en: {
    "nav.overview": "Overview",
    "nav.dashboard": "Dashboard",
    "nav.topology": "Topology",
    "nav.infrastructure": "Infrastructure",
    "nav.nodes": "Nodes",
    "nav.tunnels": "Tunnels (GRE)",
    "nav.inbounds": "OpenVPN Inbounds",
    "nav.clients": "Clients",
    "nav.routing": "Routing",
    "nav.loadbalancing": "Load balancing",
    "nav.firewall": "Firewall",
    "nav.policies": "Policies",
    "nav.ops": "Operations",
    "nav.operations": "Job queue",
    "nav.activity": "Activity",
    "nav.alerts": "Alerts",
    "nav.audit": "Audit log",
    "nav.settings": "Settings",
    "nav.controlPlane": "Control plane",
    "nav.search": "Search…",
    "nav.collapse": "Collapse sidebar",
    "nav.expand": "Expand sidebar",
    "nav.signOut": "Sign out",
    "nav.language": "Language",
    "login.title": "Sign in",
    "login.subtitle": "Arvoo control plane",
    "login.username": "Username",
    "login.password": "Password",
    "login.submit": "Sign in",
    "login.failed": "Invalid username or password",
    "common.save": "Save",
    "common.cancel": "Cancel",
    "common.create": "Create",
    "common.delete": "Delete",
    "common.edit": "Edit",
    "common.refresh": "Refresh",
    "common.loading": "Loading…",
    "common.search": "Search",
    "common.status": "Status",
    "common.actions": "Actions",
    "common.back": "Back",
    "common.confirm": "Confirm",
    "common.enabled": "Enabled",
    "common.disabled": "Disabled",
    "common.active": "Active",
    "common.inactive": "Inactive",
    "dashboard.title": "Dashboard",
    "dashboard.subtitle": "Fleet health, sessions and recent activity",
    "nodes.title": "Nodes",
    "nodes.subtitle": "Edge servers that run OpenVPN and GRE",
    "tunnels.title": "GRE tunnels",
    "tunnels.subtitle": "Site-to-site tunnels between nodes",
    "inbounds.title": "OpenVPN inbounds",
    "inbounds.subtitle": "Listener configurations deployed to nodes",
    "clients.title": "Clients",
    "clients.subtitle": "VPN identities, quotas and profiles",
    "settings.title": "Settings",
    "settings.subtitle": "Panel configuration and operators",
    "settings.language": "Interface language",
    "settings.language.hint": "Applies immediately to this browser",
    "ops.title": "Operations",
    "activity.title": "Activity",
    "alerts.title": "Alerts",
    "audit.title": "Audit log",
    "routing.title": "Routing",
    "firewall.title": "Firewall",
    "policies.title": "Policies",
    "lb.title": "Load balancing",
    "topology.title": "Topology",
  },
  fa: {
    "nav.overview": "نمای کلی",
    "nav.dashboard": "داشبورد",
    "nav.topology": "توپولوژی",
    "nav.infrastructure": "زیرساخت",
    "nav.nodes": "نودها",
    "nav.tunnels": "تونل‌های GRE",
    "nav.inbounds": "اینباندهای OpenVPN",
    "nav.clients": "کلاینت‌ها",
    "nav.routing": "مسیریابی",
    "nav.loadbalancing": "بالانس بار",
    "nav.firewall": "فایروال",
    "nav.policies": "سیاست‌ها",
    "nav.ops": "عملیات",
    "nav.operations": "صف کارها",
    "nav.activity": "فعالیت",
    "nav.alerts": "هشدارها",
    "nav.audit": "گزارش حسابرسی",
    "nav.settings": "تنظیمات",
    "nav.controlPlane": "صفحه کنترل",
    "nav.search": "جستجو…",
    "nav.collapse": "جمع کردن منو",
    "nav.expand": "باز کردن منو",
    "nav.signOut": "خروج",
    "nav.language": "زبان",
    "login.title": "ورود",
    "login.subtitle": "صفحه کنترل Arvoo",
    "login.username": "نام کاربری",
    "login.password": "رمز عبور",
    "login.submit": "ورود",
    "login.failed": "نام کاربری یا رمز عبور نادرست است",
    "common.save": "ذخیره",
    "common.cancel": "انصراف",
    "common.create": "ایجاد",
    "common.delete": "حذف",
    "common.edit": "ویرایش",
    "common.refresh": "بازنشانی",
    "common.loading": "در حال بارگذاری…",
    "common.search": "جستجو",
    "common.status": "وضعیت",
    "common.actions": "اقدامات",
    "common.back": "بازگشت",
    "common.confirm": "تأیید",
    "common.enabled": "فعال",
    "common.disabled": "غیرفعال",
    "common.active": "فعال",
    "common.inactive": "غیرفعال",
    "dashboard.title": "داشبورد",
    "dashboard.subtitle": "سلامت ناوگان، نشست‌ها و فعالیت اخیر",
    "nodes.title": "نودها",
    "nodes.subtitle": "سرورهای لبه که OpenVPN و GRE را اجرا می‌کنند",
    "tunnels.title": "تونل‌های GRE",
    "tunnels.subtitle": "تونل‌های سایت‌به‌سایت بین نودها",
    "inbounds.title": "اینباندهای OpenVPN",
    "inbounds.subtitle": "پیکربندی شنوندگان مستقر روی نودها",
    "clients.title": "کلاینت‌ها",
    "clients.subtitle": "هویت‌های VPN، سهمیه‌ها و پروفایل‌ها",
    "settings.title": "تنظیمات",
    "settings.subtitle": "پیکربندی پنل و اپراتورها",
    "settings.language": "زبان رابط",
    "settings.language.hint": "بلافاصله روی این مرورگر اعمال می‌شود",
    "ops.title": "عملیات",
    "activity.title": "فعالیت",
    "alerts.title": "هشدارها",
    "audit.title": "گزارش حسابرسی",
    "routing.title": "مسیریابی",
    "firewall.title": "فایروال",
    "policies.title": "سیاست‌ها",
    "lb.title": "بالانس بار",
    "topology.title": "توپولوژی",
  },
};

function readStoredLang(): Lang {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "fa" || v === "en") return v;
  } catch {
    /* ignore */
  }
  return "en";
}

function applyDocumentLang(lang: Lang) {
  if (typeof document === "undefined") return;
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "fa" ? "rtl" : "ltr";
}

interface I18nValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: string) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => readStoredLang());

  useEffect(() => {
    applyDocumentLang(lang);
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      /* ignore */
    }
  }, [lang]);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
  }, []);

  const t = useCallback(
    (key: string) => messages[lang][key] ?? messages.en[key] ?? key,
    [lang],
  );

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used inside I18nProvider");
  return ctx;
}

export function useT() {
  return useI18n().t;
}
