import { useEffect, useRef, useState } from "react";

/* ---------------------------------------------------------------------------
   Roda de cores HSV: matiz+saturacao no disco, brilho numa barra separada —
   mesmo padrao de qualquer seletor de cor nativo (Photoshop, Discord).

   O disco e puro CSS: conic-gradient da o matiz (angulo) e um radial-gradient
   branco->transparente por cima da a saturacao (centro branco = sem
   saturacao, borda = matiz puro). Matematicamente e o mesmo blend que a
   formula HSV->RGB produz em S, entao nao precisa de canvas nem calculo
   pixel a pixel. O brilho (V) escala tudo por igual — por isso um simples
   filter: brightness(v) no disco reproduz exatamente o eixo V do HSV.
--------------------------------------------------------------------------- */

const TAMANHO = 200;
const RAIO = TAMANHO / 2;

function hexParaRgb(hex: string): [number, number, number] {
  const limpo = hex.replace("#", "");
  const n = parseInt(limpo.length === 3 ? limpo.replace(/(.)/g, "$1$1") : limpo, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbParaHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  return [h, s, max];
}

function hsvParaRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let [r, g, b] = [0, 0, 0];
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

function rgbParaHex(r: number, g: number, b: number): string {
  const canal = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");
  return `#${canal(r)}${canal(g)}${canal(b)}`;
}

function hexParaHsv(hex: string): [number, number, number] {
  const [r, g, b] = hexParaRgb(hex);
  return rgbParaHsv(r, g, b);
}

function hsvParaHex(h: number, s: number, v: number): string {
  const [r, g, b] = hsvParaRgb(h, s, v);
  return rgbParaHex(r, g, b);
}

export function ColorWheel({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  const [h, s, v] = hexParaHsv(value);
  const hsvRef = useRef<[number, number, number]>([h, s, v]);
  const [, forceUpdate] = useState(0);
  const wheelRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);

  // So resincroniza do prop quando ele muda por fora (nao pelo proprio drag) —
  // senao cada onChange nosso viraria um round-trip que atrapalha o arrasto.
  const ultimoEmitido = useRef(value);
  useEffect(() => {
    if (value === ultimoEmitido.current) return;
    hsvRef.current = hexParaHsv(value);
    ultimoEmitido.current = value;
    forceUpdate((n) => n + 1);
  }, [value]);

  const emitir = () => {
    const hex = hsvParaHex(...hsvRef.current);
    ultimoEmitido.current = hex;
    onChange(hex);
    forceUpdate((n) => n + 1);
  };

  const arrastarRoda = (e: React.PointerEvent) => {
    const el = wheelRef.current;
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    const mover = (ev: PointerEvent | React.PointerEvent) => {
      const rect = el.getBoundingClientRect();
      const dx = ev.clientX - (rect.left + rect.width / 2);
      const dy = ev.clientY - (rect.top + rect.height / 2);
      const raio = rect.width / 2;
      const dist = Math.min(1, Math.hypot(dx, dy) / raio);
      const angulo = ((Math.atan2(dy, dx) * 180) / Math.PI + 90 + 360) % 360;
      hsvRef.current = [angulo, dist, hsvRef.current[2]];
      emitir();
    };
    mover(e);
    const onMove = (ev: PointerEvent) => mover(ev);
    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
  };

  const arrastarBarra = (e: React.PointerEvent) => {
    const el = barRef.current;
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    const mover = (ev: PointerEvent | React.PointerEvent) => {
      const rect = el.getBoundingClientRect();
      const y = Math.min(rect.height, Math.max(0, ev.clientY - rect.top));
      hsvRef.current = [hsvRef.current[0], hsvRef.current[1], 1 - y / rect.height];
      emitir();
    };
    mover(e);
    const onMove = (ev: PointerEvent) => mover(ev);
    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
  };

  const [hueAtual, satAtual, valAtual] = hsvRef.current;
  const anguloRad = ((hueAtual - 90) * Math.PI) / 180;
  const marcaX = RAIO + satAtual * RAIO * Math.cos(anguloRad);
  const marcaY = RAIO + satAtual * RAIO * Math.sin(anguloRad);
  const corTopoBarra = hsvParaHex(hueAtual, satAtual, 1);

  return (
    <div className="flex items-start gap-3">
      <div
        ref={wheelRef}
        onPointerDown={arrastarRoda}
        className="relative shrink-0 cursor-pointer touch-none select-none rounded-full"
        style={{
          width: TAMANHO,
          height: TAMANHO,
          background: "conic-gradient(from 0deg, red, yellow, lime, cyan, blue, magenta, red)",
          filter: `brightness(${valAtual})`,
        }}
      >
        <div
          className="absolute inset-0 rounded-full"
          style={{ background: "radial-gradient(circle, #fff 0%, rgba(255,255,255,0) 100%)" }}
        />
        <div
          className="pointer-events-none absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
          style={{ left: marcaX, top: marcaY, background: value }}
        />
      </div>

      <div
        ref={barRef}
        onPointerDown={arrastarBarra}
        className="relative w-6 shrink-0 cursor-pointer touch-none select-none rounded-full"
        style={{ height: TAMANHO, background: `linear-gradient(to bottom, ${corTopoBarra}, #000)` }}
      >
        <div
          className="pointer-events-none absolute inset-x-0 h-2 -translate-y-1/2 rounded-full border-2 border-white shadow"
          style={{ top: (1 - valAtual) * TAMANHO }}
        />
      </div>
    </div>
  );
}
