import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { RateLimiter, sanitizeId } from "../lib/security.js";

describe("sanitizeId", () => {
  test("rejeita travessia, pontuacao e IDs longos em vez de causar colisao", () => {
    assert.equal(sanitizeId("../../etc/passwd; DROP TABLE x"), "");
    assert.equal(sanitizeId("x".repeat(65)), "");
    assert.equal(sanitizeId("sala-1.abc"), "sala-1.abc");
  });
});

describe("RateLimiter", () => {
  test("bloqueia acima do teto na janela", () => {
    const limiter = new RateLimiter();
    let allowed = 0;
    for (let index = 0; index < 20; index++) {
      if (limiter.allow("k", 5_000, 8)) allowed++;
    }
    assert.equal(allowed, 8);
  });

  test("libera de novo quando a janela passa", async () => {
    const limiter = new RateLimiter();
    assert.equal(limiter.allow("k", 40, 1), true);
    assert.equal(limiter.allow("k", 40, 1), false);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(limiter.allow("k", 40, 1), true);
  });

  test("chaves diferentes nao se afetam", () => {
    const limiter = new RateLimiter();
    assert.equal(limiter.allow("a", 1_000, 1), true);
    assert.equal(limiter.allow("b", 1_000, 1), true);
  });
});
