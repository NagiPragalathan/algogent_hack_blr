import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

// Self-hosted so the page has no third-party font request on first paint.
// Instrument Serif ships 400 and 400-italic only; italic is the one the accent
// words use, so both weights are genuinely needed.
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";

import "./index.css";
import App from "./App.tsx";

// BrowserRouter rather than HashRouter: the page already uses the hash for
// in-page anchors (#agents, #pricing), and a hash router would have to own it.
// The cost is that the host must serve index.html for an unknown path — see
// public/_redirects and vercel.json, and the deploy note in README.md.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
