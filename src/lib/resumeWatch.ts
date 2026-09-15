/** Detecta rede nova e pausas longas do processo, inclusive suspensao do Windows. */
export function watchResume(recover: () => Promise<void>) {
  let lastTick = Date.now();
  let lastRecovery = -Infinity;
  let pending = false;
  let disposed = false;
  const run = () => {
    const now = Date.now();
    const elapsed = now - lastRecovery;
    if (disposed || pending || (elapsed >= 0 && elapsed < 5000)) return;
    lastRecovery = now;
    pending = true;
    void recover().catch(() => {}).finally(() => { pending = false; });
  };
  const tick = () => {
    const now = Date.now();
    if (now - lastTick > 60_000 || now < lastTick) run();
    lastTick = now;
  };
  const connection = (navigator as Navigator & { connection?: EventTarget }).connection;
  window.addEventListener("online", run);
  connection?.addEventListener("change", run);
  document.addEventListener("visibilitychange", tick);
  const timer = window.setInterval(tick, 15000);
  return () => {
    disposed = true;
    window.clearInterval(timer);
    window.removeEventListener("online", run);
    connection?.removeEventListener("change", run);
    document.removeEventListener("visibilitychange", tick);
  };
}
