import { memo, useState } from "react";
import { AlertTriangle, KeyRound, Waves } from "lucide-react";
import { USER_COLORS, hasTurn } from "../lib/config";
import { session } from "../lib/session";
import { supabaseEnabled } from "../lib/supabase";
import { loadPrefs } from "../lib/prefs";

/** Entrada sem senha de conta: so nome, cor e a senha da sala (se houver).
 *  O objetivo e cair na sala em 3 segundos. */
function LoginGateBase({ onDone }: { onDone: () => void }) {
  const saved = loadPrefs();
  const [name, setName] = useState(saved.name);
  const [color, setColor] = useState(saved.color || USER_COLORS[0]);
  const [token, setToken] = useState(
    saved.token || ((import.meta.env.VITE_ROOM_TOKEN as string) ?? "")
  );
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState("");

  const enter = async () => {
    const nick = name.trim();
    if (nick.length < 2 || busy) return;
    setBusy(true);
    setErro("");
    const res = await session.start(nick, color, token.trim());
    if (!res.ok) {
      // Fica na tela de login: senha errada ou servidor dormindo sao os dois
      // casos comuns, e ambos se resolvem tentando de novo aqui mesmo.
      setErro(res.error ?? "Nao foi possivel conectar");
      setBusy(false);
      return;
    }
    onDone();
  };

  return (
    <div className="grid h-full place-items-center bg-base-800">
      <div className="w-80 rounded-xl border border-line bg-base-600 p-6 shadow-2xl">
        <div className="mb-5 flex items-center gap-2">
          <Waves size={22} className="text-brand" />
          <h1 className="text-lg font-bold tracking-wide text-ink">VOXA</h1>
        </div>

        <label className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-faint">
          Como te chamam?
        </label>
        <input
          autoFocus
          value={name}
          maxLength={32}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void enter()}
          placeholder="seu nick"
          className="mb-4 w-full rounded-md bg-base-500 px-3 py-2 text-ink outline-none ring-brand focus:ring-2"
        />

        <label className="mb-1 flex items-center gap-1 text-[11px] font-bold uppercase tracking-wide text-faint">
          <KeyRound size={11} />
          Senha da sala
        </label>
        <input
          value={token}
          maxLength={64}
          type="password"
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void enter()}
          placeholder="deixe vazio se o servidor for aberto"
          className="mb-4 w-full rounded-md bg-base-500 px-3 py-2 text-ink outline-none ring-brand focus:ring-2"
        />

        <label className="mb-2 block text-[11px] font-bold uppercase tracking-wide text-faint">
          Cor
        </label>
        <div className="mb-5 flex flex-wrap gap-2">
          {USER_COLORS.map((c) => (
            <button
              key={c}
              onClick={() => setColor(c)}
              className="size-7 rounded-full transition-transform hover:scale-110"
              style={{
                background: c,
                outline: color === c ? "2px solid var(--color-ink)" : "2px solid transparent",
                outlineOffset: 2,
              }}
            />
          ))}
        </div>

        {erro && (
          <p className="mb-3 flex items-start gap-2 rounded-md bg-danger/15 px-3 py-2 text-[13px] text-danger">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            {erro}
          </p>
        )}

        <button
          onClick={() => void enter()}
          disabled={name.trim().length < 2 || busy}
          className="w-full rounded-md bg-brand py-2 font-semibold text-white transition-colors enabled:hover:bg-brand-hover disabled:opacity-50"
        >
          {busy ? "Conectando..." : "Entrar"}
        </button>

        {busy && (
          <p className="mt-2 text-center text-[11px] text-faint">
            o servidor pode levar ate 30s para acordar
          </p>
        )}

        <p className="mt-3 text-center text-[11px] text-faint">
          {supabaseEnabled ? "historico no Supabase" : "modo efemero"} ·{" "}
          {hasTurn ? "TURN configurado" : "so STUN"}
        </p>
      </div>
    </div>
  );
}

export const LoginGate = memo(LoginGateBase);
