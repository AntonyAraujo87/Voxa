/** Reserva atomica antes de alocar um transporte Engine.IO, inclusive sem hello. */
export class Admission {
  #ips = new Map();
  #total = 0;
  constructor(maxTotal = 128, maxPerIp = 10) { this.maxTotal = maxTotal; this.maxPerIp = maxPerIp; }
  reserve(ip) {
    const count = this.#ips.get(ip) ?? 0;
    if (this.#total >= this.maxTotal || count >= this.maxPerIp) return null;
    this.#total++;
    this.#ips.set(ip, count + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      this.#total--;
      const next = this.#ips.get(ip) - 1;
      if (next) this.#ips.set(ip, next); else this.#ips.delete(ip);
    };
    const timer = setTimeout(release, 30000);
    timer.unref?.();
    return { release, connected: () => clearTimeout(timer) };
  }
}
