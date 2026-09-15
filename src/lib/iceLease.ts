/** Credenciais temporarias: uma renovacao por vez e retry apos falha. */
export class IceLease {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private failures = 0;
  private active = false;
  private pending: Promise<boolean> | null = null;

  constructor(
    private fetchConfig: () => Promise<RTCIceServer[]>,
    private apply: (servers: RTCIceServer[]) => void,
    private connected: () => boolean,
    private timings = { refresh: 40 * 60_000, retry: 5000, maxRetry: 60_000 },
  ) {}

  start(servers: RTCIceServer[]) {
    this.stop();
    this.active = true;
    this.failures = 0;
    this.apply(servers);
    this.schedule(this.timings.refresh);
  }

  stop() {
    this.generation++;
    this.active = false;
    this.pending = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delay: number) {
    if (this.timer) clearTimeout(this.timer);
    if (!this.active) return;
    this.timer = setTimeout(() => { this.timer = null; void this.refresh(); }, delay);
  }

  refresh(): Promise<boolean> {
    if (!this.active) return Promise.resolve(false);
    if (this.pending) return this.pending;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const generation = this.generation;
    const operation = (async () => {
      try {
        if (!this.connected()) throw new Error("offline");
        const servers = await this.fetchConfig();
        if (!this.active || generation !== this.generation) return false;
        if (!Array.isArray(servers)) throw new Error("invalid ICE config");
        this.apply(servers);
        this.failures = 0;
        this.schedule(this.timings.refresh);
        return true;
      } catch {
        if (this.active && generation === this.generation) {
          this.schedule(Math.min(this.timings.maxRetry, this.timings.retry * 2 ** Math.min(this.failures++, 6)));
        }
        return false;
      }
    })();
    this.pending = operation;
    void operation.finally(() => { if (this.pending === operation) this.pending = null; });
    return operation;
  }
}
