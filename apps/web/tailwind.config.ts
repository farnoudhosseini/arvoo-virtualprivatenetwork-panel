import type { Config } from "tailwindcss";

/**
 * Arvoo design system — Tailwind mapping.
 *
 * Every color resolves to a CSS variable declared in styles/globals.css so the
 * palette has one source of truth and can be tuned without touching markup.
 * Surfaces are layered (bg -> surface -> surface-2 -> surface-3) and every
 * elevation step also gets a border + shadow pair, which is what makes dense
 * infrastructure tables readable instead of flat.
 */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        /* Surfaces.
           Mapped through `rgb(<triplet> / <alpha-value>)` so Tailwind's opacity
           modifiers (`bg-surface-2/60`, `border-accent/40`) actually emit CSS
           instead of being dropped silently. */
        bg: "rgb(var(--bg-rgb) / <alpha-value>)",
        "bg-elevated": "rgb(var(--bg-elevated-rgb) / <alpha-value>)",
        surface: "rgb(var(--surface-rgb) / <alpha-value>)",
        "surface-2": "rgb(var(--surface-2-rgb) / <alpha-value>)",
        "surface-3": "rgb(var(--surface-3-rgb) / <alpha-value>)",
        "surface-inset": "rgb(var(--surface-inset-rgb) / <alpha-value>)",
        "surface-glass": "rgb(var(--surface-glass-rgb) / <alpha-value>)",
        /* Lines */
        line: "rgb(var(--line-rgb) / <alpha-value>)",
        "line-strong": "rgb(var(--line-strong-rgb) / <alpha-value>)",
        "line-soft": "rgb(var(--line-soft-rgb) / <alpha-value>)",
        /* Text */
        text: "rgb(var(--text-rgb) / <alpha-value>)",
        muted: "rgb(var(--muted-rgb) / <alpha-value>)",
        faint: "rgb(var(--faint-rgb) / <alpha-value>)",
        /* Accent (Arvoo Red) */
        accent: "rgb(var(--accent-rgb) / <alpha-value>)",
        "accent-hover": "rgb(var(--accent-hover-rgb) / <alpha-value>)",
        "accent-fg": "rgb(var(--accent-fg-rgb) / <alpha-value>)",
        "accent-soft": "var(--accent-soft)",
        /* Semantic */
        success: "rgb(var(--success-rgb) / <alpha-value>)",
        "success-soft": "var(--success-soft)",
        warning: "rgb(var(--warning-rgb) / <alpha-value>)",
        "warning-soft": "var(--warning-soft)",
        danger: "rgb(var(--danger-rgb) / <alpha-value>)",
        "danger-soft": "var(--danger-soft)",
        info: "rgb(var(--info-rgb) / <alpha-value>)",
        "info-soft": "var(--info-soft)",
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "Helvetica Neue", "Arial", "sans-serif"],
        mono: ["ui-monospace", "SF Mono", "Cascadia Code", "JetBrains Mono", "Menlo", "Consolas", "monospace"],
      },
      fontSize: {
        "2xs": ["0.6875rem", "1rem"],
        "3xs": ["0.625rem", "0.875rem"],
      },
      spacing: {
        sidebar: "var(--sidebar-w)",
        "sidebar-collapsed": "var(--sidebar-w-collapsed)",
        topbar: "var(--topbar-h)",
      },
      borderRadius: {
        sm: "5px",
        DEFAULT: "8px",
        default: "8px",
        md: "9px",
        lg: "12px",
        xl: "16px",
      },
      boxShadow: {
        /* Depth ramp used by cards, popovers and modals. */
        hairline: "0 1px 0 0 rgba(255,255,255,0.02) inset",
        card: "0 1px 2px rgba(0,0,0,0.4), 0 8px 24px -16px rgba(0,0,0,0.8)",
        raised: "0 2px 6px rgba(0,0,0,0.45), 0 16px 40px -24px rgba(0,0,0,0.9)",
        overlay: "0 24px 64px -24px rgba(0,0,0,0.85), 0 2px 8px rgba(0,0,0,0.5)",
        accent: "0 0 0 1px var(--accent-soft), 0 8px 30px -12px var(--accent-glow)",
        inset: "inset 0 1px 2px rgba(0,0,0,0.45)",
      },
      transitionTimingFunction: {
        /* Single, consistent easing curve for the whole product. */
        arvoo: "cubic-bezier(0.32, 0.72, 0, 1)",
        "out-quint": "cubic-bezier(0.22, 1, 0.36, 1)",
      },
      transitionDuration: {
        fast: "120ms",
        DEFAULT: "180ms",
        slow: "240ms",
      },
      keyframes: {
        "fade-in": { from: { opacity: "0", transform: "translateY(2px)" }, to: { opacity: "1", transform: "translateY(0)" } },
        "fade-out": { from: { opacity: "1" }, to: { opacity: "0" } },
        "scale-in": { from: { opacity: "0", transform: "scale(0.97)" }, to: { opacity: "1", transform: "scale(1)" } },
        "slide-in-right": { from: { opacity: "0", transform: "translateX(12px)" }, to: { opacity: "1", transform: "translateX(0)" } },
        "slide-up": { from: { opacity: "0", transform: "translateY(6px)" }, to: { opacity: "1", transform: "translateY(0)" } },
        shimmer: { "100%": { transform: "translateX(100%)" } },
        "pulse-soft": { "0%, 100%": { opacity: "1" }, "50%": { opacity: "0.45" } },
        "bar-grow": { from: { transform: "scaleX(0)" }, to: { transform: "scaleX(1)" } },
      },
      animation: {
        "fade-in": "fade-in 180ms cubic-bezier(0.32,0.72,0,1)",
        "fade-out": "fade-out 120ms ease-out",
        "scale-in": "scale-in 180ms cubic-bezier(0.22,1,0.36,1)",
        "slide-in-right": "slide-in-right 200ms cubic-bezier(0.22,1,0.36,1)",
        "slide-up": "slide-up 180ms cubic-bezier(0.22,1,0.36,1)",
        shimmer: "shimmer 1.6s infinite",
        "pulse-soft": "pulse-soft 2.4s ease-in-out infinite",
        "bar-grow": "bar-grow 400ms cubic-bezier(0.22,1,0.36,1)",
      },
      gridTemplateColumns: {
        /* Dense infrastructure dashboards: 2/3/4 columns without breakpoints. */
        cards: "repeat(auto-fit, minmax(190px, 1fr))",
      },
      backdropBlur: { xs: "2px" },
    },
  },
  plugins: [],
} satisfies Config;
