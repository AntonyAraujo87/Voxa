import { memo } from "react";

interface Props {
  name: string;
  color: string;
  size?: number;
  speaking?: boolean;
  muted?: boolean;
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

function AvatarBase({ name, color, size = 32, speaking = false }: Props) {
  return (
    <div
      className="relative grid shrink-0 place-items-center rounded-full font-semibold text-white/95"
      style={{
        width: size,
        height: size,
        background: color,
        fontSize: size * 0.38,
        // outline em vez de border: nao muda o layout quando aparece/some,
        // entao o anel de "falando" nao empurra nada na lista.
        outline: speaking ? "2px solid var(--color-online)" : "2px solid transparent",
        outlineOffset: 2,
        transition: "outline-color 90ms linear",
      }}
    >
      {initials(name)}
    </div>
  );
}

export const Avatar = memo(AvatarBase);
