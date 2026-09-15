import express from "express";
import { rateLimit } from "express-rate-limit";
import { requestIp } from "./security.js";

export function createHttpApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(rateLimit({
    windowMs: 60000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false,
    keyGenerator: requestIp,
    message: { error: "muitas-requisicoes" },
    validate: { keyGeneratorIpFallback: false },
  }));
  app.get("/health", (_req, res) => {
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.json({ ok: true });
  });
  app.use((_req, res) => res.status(404).type("text/plain").send("not found"));
  app.use((_error, _req, res, _next) => res.status(500).json({ error: "falha-interna" }));
  return app;
}
