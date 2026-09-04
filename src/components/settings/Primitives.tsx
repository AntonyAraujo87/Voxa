/* ---------------------------------------------------------------------------
   Blocos visuais compartilhados por todas as secoes de configuracao.

   Vivem separados porque cada secao que sai do SettingsModal para arquivo
   proprio precisa deles — deixa-los la dentro obrigaria cada extracao a
   arrastar o modal inteiro junto.
--------------------------------------------------------------------------- */

export function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-6">
      <h3 className="mb-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-wide text-faint">
        {icon}
        {title}
      </h3>
      {children}
    </section>
  );
}

/** Cartao de escolha unica — o par "Voz/Estudio", "Natural/Nivelado", etc. */
export function Option({
  active,
  label,
  hint,
  onClick,
}: {
  active: boolean;
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full rounded-md border px-3 py-2 text-left transition-colors ${
        active
          ? "border-brand bg-brand/15 text-ink"
          : "border-transparent bg-base-500/60 text-muted hover:bg-base-500"
      }`}
    >
      <p className="text-sm font-medium">{label}</p>
      <p className="text-xs text-faint">{hint}</p>
    </button>
  );
}
