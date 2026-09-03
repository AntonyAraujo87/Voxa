import { memo } from "react";

/**
 * Marca do Voxa: o mesmo anel de voz do icone do aplicativo.
 *
 * Desenhado inline em vez de importar o PNG porque aqui ele herda `currentColor`
 * nas barras e acompanha o tema, e porque em 16-22px um SVG vetorial fica
 * nitido onde o bitmap ficaria borrado.
 */
function VoxaMarkBase({ size = 22, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      className={className}
      role="img"
      aria-label="Voxa"
    >
      <defs>
        <linearGradient id="voxa-anel" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#A855F7" />
          <stop offset="100%" stopColor="#5865F2" />
        </linearGradient>
      </defs>
      <circle cx="512" cy="512" r="296" fill="none" stroke="url(#voxa-anel)" strokeWidth="86" />
      <circle
        cx="512"
        cy="512"
        r="296"
        fill="none"
        stroke="currentColor"
        strokeWidth="86"
        strokeDasharray="250 4000"
        strokeLinecap="round"
        opacity="0.45"
        transform="rotate(-62 512 512)"
      />
      <g fill="currentColor">
        <rect x="386" y="452" width="52" height="120" rx="26" />
        <rect x="486" y="392" width="52" height="240" rx="26" />
        <rect x="586" y="472" width="52" height="80" rx="26" />
      </g>
    </svg>
  );
}

export const VoxaMark = memo(VoxaMarkBase);
