import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
