import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { Toaster } from "sonner";
import App from "./App";
import { I18nProvider } from "./lib/i18n";
import "./styles/globals.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 10_000,
    },
  },
});

/**
 * Vite injects BASE_URL from `base` in vite.config (default "/").
 * When the panel is built with VITE_BASE=/panel/, routes live under that prefix.
 */
function routerBasename(): string | undefined {
  const raw = import.meta.env.BASE_URL || "/";
  const trimmed = String(raw).replace(/\/$/, "");
  return trimmed === "" || trimmed === "/" ? undefined : trimmed;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <BrowserRouter basename={routerBasename()}>
          <Toaster
            theme="dark"
            position="bottom-right"
            toastOptions={{
              style: {
                background: "#1a1d22",
                border: "1px solid #2e323b",
                color: "#e8eaee",
                fontSize: "13px",
              },
            }}
          />
          <App />
        </BrowserRouter>
      </I18nProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
