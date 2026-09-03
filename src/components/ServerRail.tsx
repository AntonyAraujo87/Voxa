import { memo } from "react";
import { Compass, Plus, Waves } from "lucide-react";

function Pill({ active }: { active: boolean }) {
  return (
    <span
      className="absolute -left-3 w-1 rounded-r-full bg-ink transition-all duration-150"
      style={{ height: active ? 40 : 8, opacity: active ? 1 : 0.35 }}
    />
  );
}

function ServerRailBase() {
  return (
    <nav className="flex w-[72px] shrink-0 flex-col items-center gap-2 bg-base-900 py-3">
      <button className="group relative grid size-12 place-items-center rounded-2xl bg-brand text-white transition-all hover:rounded-xl">
        <Pill active />
        <Waves size={22} />
      </button>

      <div className="my-1 h-px w-8 bg-base-700" />

      <button
        className="grid size-12 place-items-center rounded-3xl bg-base-700 text-online transition-all hover:rounded-xl hover:bg-online hover:text-white"
        title="Criar servidor (em breve)"
      >
        <Plus size={22} />
      </button>
      <button
        className="grid size-12 place-items-center rounded-3xl bg-base-700 text-online transition-all hover:rounded-xl hover:bg-online hover:text-white"
        title="Explorar (em breve)"
      >
        <Compass size={22} />
      </button>
    </nav>
  );
}

export const ServerRail = memo(ServerRailBase);
