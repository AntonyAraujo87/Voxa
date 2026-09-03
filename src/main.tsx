import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { Overlay } from "./components/Overlay";
import "./index.css";

// Janela overlay (ver src-tauri/src/overlay.rs) carrega "index.html#overlay"
// — mesmo bundle, ponto de entrada diferente. Ela precisa de fundo
// transparente de verdade: o `body` do resto do app e opaco de proposito.
const ehOverlay = window.location.hash === "#overlay";
if (ehOverlay) document.body.style.background = "transparent";

createRoot(document.getElementById("root")!).render(
  <StrictMode>{ehOverlay ? <Overlay /> : <App />}</StrictMode>
);
