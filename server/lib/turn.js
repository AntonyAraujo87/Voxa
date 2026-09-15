import { createHmac } from "node:crypto";

/** Credenciais temporarias compativeis com coturn use-auth-secret. */
export function turnCredentials(identity, env = process.env, now = Date.now()) {
  const urls = (env.VOXA_TURN_URLS ?? "").split(",").map(value => value.trim()).filter(value => /^turns?:[^\s]+$/.test(value));
  const secret = env.VOXA_TURN_SECRET;
  if (!urls.length || !secret) return [];
  const username = `${Math.floor(now / 1000) + 3600}:${identity}`;
  const credential = createHmac("sha1", secret).update(username).digest("base64");
  return [{ urls, username, credential }];
}
