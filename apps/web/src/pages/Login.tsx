import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertCircle, Lock, Network, ShieldCheck, User } from "lucide-react";
import { api, ApiError } from "../lib/api";
import { Button, Field, Input, Kbd, StatusDot } from "../components/ui/primitives";

const FACTS = [
  { icon: <Network size={14} />, title: "Node-agent fabric", text: "Every change is a typed operation executed by an approved agent — verified, never assumed." },
  { icon: <ShieldCheck size={14} />, title: "Zero leaked secrets", text: "Keys and secrets are encrypted at rest and never travel through the browser." },
  { icon: <Lock size={14} />, title: "Fully audited", text: "Sign-ins, configuration changes and deployments are recorded against the acting identity." },
];

export function LoginPage() {
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Public health probe — the footer claim is read from the API, never assumed.
  const [health, setHealth] = useState<"checking" | "ok" | "degraded" | "unreachable">("checking");

  useEffect(() => {
    let alive = true;
    fetch("/health")
      .then(async (res) => {
        if (!alive) return;
        const body = (await res.json().catch(() => null)) as { database?: string } | null;
        setHealth(res.ok && body?.database === "ok" ? "ok" : "degraded");
      })
      .catch(() => alive && setHealth("unreachable"));
    return () => {
      alive = false;
    };
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await api.post("/auth/login", { username, password });
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Sign-in failed. Check your connection.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-full">
      {/* ------------------------------------------------------- brand panel */}
      <div className="relative hidden w-[44%] max-w-[620px] shrink-0 flex-col justify-between overflow-hidden border-r border-line bg-bg-elevated p-10 lg:flex">
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(680px 420px at 12% 0%, rgba(229,72,77,0.14), transparent 62%), radial-gradient(600px 420px at 100% 100%, rgba(74,158,255,0.07), transparent 60%)",
          }}
          aria-hidden
        />
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.5]"
          style={{
            backgroundImage:
              "linear-gradient(var(--line-soft) 1px, transparent 1px), linear-gradient(90deg, var(--line-soft) 1px, transparent 1px)",
            backgroundSize: "56px 56px",
            maskImage: "radial-gradient(75% 60% at 30% 20%, #000 0%, transparent 75%)",
          }}
          aria-hidden
        />

        <div className="relative flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-[9px] bg-gradient-to-b from-accent to-[#c03236] text-sm font-bold text-white shadow-[0_1px_0_rgba(255,255,255,0.25)_inset,0_8px_20px_-10px_var(--accent-glow)]">
            A
          </span>
          <span className="leading-none">
            <span className="block text-[15px] font-semibold tracking-[0.16em] text-text">ARVOO</span>
            <span className="mt-1 block text-3xs font-medium uppercase tracking-[0.18em] text-faint">Control plane</span>
          </span>
        </div>

        <div className="relative">
          <h2 className="max-w-md text-[26px] font-semibold leading-tight tracking-tight text-text">
            Infrastructure control, without the guesswork.
          </h2>
          <p className="mt-3 max-w-md text-xs leading-relaxed text-muted">
            Arvoo runs OpenVPN inbounds, GRE links and client identities across your own servers — and reports only what the agents actually
            confirmed.
          </p>

          <ul className="mt-7 space-y-4">
            {FACTS.map((f) => (
              <li key={f.title} className="flex gap-3">
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-[7px] border border-line bg-surface-2 text-muted">
                  {f.icon}
                </span>
                <span className="min-w-0">
                  <span className="block text-xs font-medium text-text">{f.title}</span>
                  <span className="mt-0.5 block max-w-sm text-2xs leading-relaxed text-muted">{f.text}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="relative flex items-center gap-2 text-3xs text-faint">
          <StatusDot tone={health === "ok" ? "success" : health === "checking" ? "neutral" : health === "degraded" ? "warning" : "danger"} live={health === "ok"} />
          {health === "ok"
            ? "Control plane online · PostgreSQL connected"
            : health === "checking"
              ? "Checking control plane…"
              : health === "degraded"
                ? "Control plane reachable · database degraded"
                : "Control plane unreachable"}
        </div>
      </div>

      {/* ------------------------------------------------------------- form */}
      <div className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="w-full max-w-[360px]">
          <div className="mb-7 flex items-center gap-2.5 lg:hidden">
            <span className="flex size-8 items-center justify-center rounded-[9px] bg-gradient-to-b from-accent to-[#c03236] text-sm font-bold text-white">
              A
            </span>
            <span className="leading-none">
              <span className="block text-[14px] font-semibold tracking-[0.16em] text-text">ARVOO</span>
              <span className="mt-1 block text-3xs font-medium uppercase tracking-[0.18em] text-faint">Control plane</span>
            </span>
          </div>

          <h1 className="text-[17px] font-semibold tracking-tight text-text">Sign in</h1>
          <p className="mt-1 text-xs text-muted">Access is restricted. Every action is audited.</p>

          <form onSubmit={submit} className="mt-6 space-y-4">
            <Field label="Username">
              <div className="relative">
                <User size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
                <Input
                  autoFocus
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  required
                  className="pl-8"
                  placeholder="admin"
                />
              </div>
            </Field>
            <Field label="Password">
              <div className="relative">
                <Lock size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                  className="pl-8"
                  placeholder="••••••••"
                />
              </div>
            </Field>

            {error && (
              <div className="flex items-start gap-2.5 rounded-default border border-danger/30 bg-danger-soft px-3 py-2.5 text-2xs leading-relaxed text-danger">
                <AlertCircle size={13} className="mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <Button type="submit" variant="primary" size="lg" className="w-full" loading={loading}>
              Sign in
            </Button>
          </form>

          <p className="mt-6 text-3xs leading-relaxed text-faint">
            Sessions are signed cookies. Sign out from the account menu in the top bar. Failed attempts are rate-limited and recorded in the audit
            log.
          </p>
          <p className="mt-3 text-3xs text-faint">
            Tip: press <Kbd>Ctrl</Kbd> <Kbd>K</Kbd> anywhere in the panel to jump to any page or action.
          </p>
        </div>
      </div>
    </div>
  );
}
