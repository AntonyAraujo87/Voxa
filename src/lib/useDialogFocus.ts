import { useEffect, useRef } from "react";

export function useDialogFocus(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const onClose = useRef(close);
  onClose.current = close;
  useEffect(() => {
    if (!open || !ref.current) return;
    const dialog = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () => [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select,textarea,a[href],[tabindex="0"]')].filter(el => el.getClientRects().length > 0);
    (focusable()[0] ?? dialog).focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose.current(); }
      if (event.key !== "Tab") return;
      const elements = focusable();
      const first = elements[0] ?? dialog, last = elements[elements.length - 1] ?? dialog;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    dialog.addEventListener("keydown", key);
    return () => { dialog.removeEventListener("keydown", key); if (previous?.isConnected) previous.focus(); };
  }, [open]);
  return ref;
}
