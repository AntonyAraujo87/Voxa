import { defineConfig, loadEnv } from "vite";
// @ts-expect-error build helper executado pelo Node, fora do bundle do app
import { buildInfo } from "./scripts/build-info.mjs";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  define: { __VOXA_BUILD__: JSON.stringify(buildInfo({ ...loadEnv(mode, process.cwd(), "VITE_"), ...process.env })) },
  plugins: [react(), tailwindcss()],

  // Tauri: nao limpar a tela pra nao esconder os erros do Rust
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**", "**/server/**"] },
  },
  build: {
    // WebView2 (Win) / WKWebView (mac) sao Chromium/Safari modernos:
    // alvo alto = menos polyfill = bundle menor = boot mais rapido.
    target: "chrome110",
    minify: "esbuild",
    sourcemap: false,
    cssMinify: "lightningcss",
  },
  esbuild: {
    legalComments: "none",
    drop: process.env.NODE_ENV === "production" ? ["debugger"] : [],
  },
}));
