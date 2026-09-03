import { memo, useState } from "react";
import { AlertTriangle, KeyRound, Pencil } from "lucide-react";
import { VoxaMark } from "./VoxaMark";
import { Avatar } from "./Avatar";
import { ColorWheel } from "./ColorWheel";
import { USER_COLORS, hasTurn } from "../lib/config";
import { session } from "../lib/session";
import { supabaseEnabled } from "../lib/supabase";
import { loadPrefs, savePrefs } from "../lib/prefs";

/* ---------------------------------------------------------------------------
   Entrada em duas etapas.

   Nome e cor sao escolhidos UMA VEZ so — isso e identidade, nao muda a cada
   abertura do app. Depois disso, toda vez que o Voxa abre, a unica pergunta
   e o codigo do servidor: e o dado que de fato muda (senha nova, outro
   servidor de amigos, etc). Forcar a pessoa a redigitar nome e escolher cor
   de novo a cada abertura era atrito sem motivo.
--------------------------------------------------------------------------- */

const CardShell = ({ children }: { children: React.ReactNode }) => (
  <div className="grid h-full place-items-center bg-base-800">
    <div className="w-80 rounded-xl border border-line bg-base-600 p-6 shadow-2xl">
      {children}
    </div>
  </div>
);

interface ProfileProps {
  onDone: (name: string, color: string) => void;
}

/** So aparece na primeira vez que o app abre nesta instalacao. */
function ProfileSetup({ onDone }: ProfileProps) {
  const [name, setName] = useState("");
  const [color, setColor] = useState(USER_COLORS[0]);

  const confirmar = () => {
    const nick = name.trim();
    if (nick.length < 2) return;
    onDone(nick, color);
  };

  return (
    <CardShell>
      <div className="mb-5 flex items-center gap-2">
        <VoxaMark size={24} className="text-ink" />
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
        onKeyDown={(e) => e.key === "Enter" && confirmar()}
        placeholder="seu nick"
        className="mb-4 w-full rounded-md bg-base-500 px-3 py-2 text-ink outline-none ring-brand focus:ring-2"
      />

      <label className="mb-2 block text-[11px] font-bold uppercase tracking-wide text-faint">
        Cor
      </label>
      <div className="mb-5 flex justify-center">
        <ColorWheel value={color} onChange={setColor} />
      </div>

      <button
        onClick={confirmar}
        disabled={name.trim().length < 2}
        className="w-full rounded-md bg-brand py-2 font-semibold text-white transition-colors enabled:hover:bg-brand-hover disabled:opacity-50"
      >
        Continuar
      </button>
      <p className="mt-3 text-center text-[11px] text-faint">
        so pergunta isso uma vez — da pra trocar depois
      </p>
    </CardShell>
  );
}

interface ServerCodeProps {
  name: string;
  color: string;
  onEditProfile: () => void;
  onDone: () => void;
}

/** Tela padrao a partir da segunda abertura: so o codigo do servidor. */
function ServerCode({ name, color, onEditProfile, onDone }: ServerCodeProps) {
  const saved = loadPrefs();
  const [token, setToken] = useState(
    saved.token || ((import.meta.env.VITE_ROOM_TOKEN as string) ?? "")
  );
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState("");

  const enter = async () => {
    if (busy) return;
    setBusy(true);
    setErro("");
    const res = await session.start(name, color, token.trim());
    if (!res.ok) {
      // Fica na tela: codigo errado ou servidor dormindo sao os dois casos
      // comuns, e ambos se resolvem tentando de novo aqui mesmo.
      setErro(res.error ?? "Nao foi possivel conectar");
      setBusy(false);
      return;
    }
    onDone();
  };

  return (
    <CardShell>
      <div className="mb-5 flex items-center gap-3">
        <Avatar name={name} color={color} size={40} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold text-ink">{name}</p>
          <button
            onClick={onEditProfile}
            className="flex items-center gap-1 text-[11px] text-faint transition-colors hover:text-ink-soft"
          >
            <Pencil size={10} />
            trocar nome ou cor
          </button>
        </div>
      </div>

      <label className="mb-1 flex items-center gap-1 text-[11px] font-bold uppercase tracking-wide text-faint">
        <KeyRound size={11} />
        Código do servidor
      </label>
      <input
        autoFocus
        value={token}
        maxLength={64}
        type="password"
        onChange={(e) => setToken(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && void enter()}
        placeholder="deixe vazio se o servidor for aberto"
        className="mb-4 w-full rounded-md bg-base-500 px-3 py-2 text-ink outline-none ring-brand focus:ring-2"
      />

      {erro && (
        <p className="mb-3 flex items-start gap-2 rounded-md bg-danger/15 px-3 py-2 text-[13px] text-danger">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          {erro}
        </p>
      )}

      <button
        onClick={() => void enter()}
        disabled={busy}
        className="w-full rounded-md bg-brand py-2 font-semibold text-white transition-colors enabled:hover:bg-brand-hover disabled:opacity-50"
      >
        {busy ? "Conectando..." : "Entrar"}
      </button>

      {busy && (
        <p className="mt-2 text-center text-[11px] text-faint">
          o servidor pode levar até 30s para acordar
        </p>
      )}

      <p className="mt-3 text-center text-[11px] text-faint">
        {supabaseEnabled ? "histórico no Supabase" : "modo efêmero"} ·{" "}
        {hasTurn ? "TURN configurado" : "só STUN"}
      </p>
    </CardShell>
  );
}

function LoginGateBase({ onDone }: { onDone: () => void }) {
  const saved = loadPrefs();
  // Perfil ja existe (nome salvo de uma vez anterior) => pula direto pro
  // codigo do servidor. So volta pra tela de perfil se o usuario pedir.
  const [step, setStep] = useState<"profile" | "server">(saved.name ? "server" : "profile");
  const [name, setName] = useState(saved.name);
  const [color, setColor] = useState(saved.color || USER_COLORS[0]);

  const salvarPerfil = (novoNome: string, novaCor: string) => {
    setName(novoNome);
    setColor(novaCor);
    // Grava na hora: se o app fechar antes do "Entrar", o perfil nao se perde
    // e a proxima abertura ja cai direto na tela do codigo.
    savePrefs({ name: novoNome, color: novaCor });
    setStep("server");
  };

  if (step === "profile") {
    return <ProfileSetup onDone={salvarPerfil} />;
  }

  return (
    <ServerCode
      name={name}
      color={color}
      onEditProfile={() => setStep("profile")}
      onDone={onDone}
    />
  );
}

export const LoginGate = memo(LoginGateBase);
