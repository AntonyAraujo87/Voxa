import { memo, useEffect } from "react";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import { useApp, type Toast } from "../store/store";

const ICON = {
  info: <Info size={16} className="text-brand" />,
  ok: <CheckCircle2 size={16} className="text-online" />,
  error: <AlertTriangle size={16} className="text-danger" />,
};

const Item = memo(function Item({ toast }: { toast: Toast }) {
  const drop = useApp((s) => s.dropToast);

  useEffect(() => {
    const t = window.setTimeout(() => drop(toast.id), 5200);
    return () => window.clearTimeout(t);
  }, [toast.id, drop]);

  return (
    <div className="animate-pop flex items-center gap-2 rounded-lg border border-line bg-base-700 px-3 py-2 text-sm text-ink-soft shadow-xl">
      {ICON[toast.kind]}
      <span className="max-w-80">{toast.text}</span>
      <button
        onClick={() => drop(toast.id)}
        className="ml-1 text-faint transition-colors hover:text-ink"
      >
        <X size={14} />
      </button>
    </div>
  );
});

function ToastsBase() {
  const toasts = useApp((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none absolute bottom-4 right-4 z-50 flex flex-col items-end gap-2">
      {toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto">
          <Item toast={t} />
        </div>
      ))}
    </div>
  );
}

export const Toasts = memo(ToastsBase);
