import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./theme/theme.css";
import "./app.css";
import type { ShadowApiClient } from "./api/client.ts";
import { FakeApiClient } from "./api/fake-client.ts";
import { HttpApiClient } from "./api/http-client.ts";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { ThemeProvider } from "./theme/ThemeProvider.tsx";

declare global {
  interface Window {
    /** Set by dev.html so `bun run dev` can demonstrate the SPA against the fake client, without a running @shadow/api. */
    shadowUseFakeClient?: boolean;
  }
}

const client: ShadowApiClient = window.shadowUseFakeClient
  ? new FakeApiClient({ streamDelayMs: 220 })
  : new HttpApiClient("/api");

const container = document.getElementById("root");
if (!container) throw new Error("missing #root element");

createRoot(container).render(
  <ErrorBoundary>
    <ThemeProvider>
      <App client={client} />
    </ThemeProvider>
  </ErrorBoundary>,
);
