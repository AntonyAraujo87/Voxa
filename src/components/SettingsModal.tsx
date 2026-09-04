import { memo, useEffect, useState } from "react";
import { Bell, Camera, Cpu, Gamepad2, Gauge, LifeBuoy, Mic, MonitorPlay, MonitorSmartphone, RadioTower, RefreshCw, Volume2, X } from "lucide-react";
import { useApp } from "../store/store";
import { session } from "../lib/session";
import { outputSupport } from "../lib/audioOutput";
import { Section, Option } from "./settings/Primitives";
import { HotkeysSection } from "./settings/HotkeysSection";
import { copiarTexto, montarRelatorio } from "../lib/diagnostico";
import {
  isDesktop,
  listCaptureSources,
  getCaptureSource,
  setCaptureSource,
  type CaptureSource,
} from "../lib/desktop";
import {
  AUDIO_PRESETS,
  CODEC_ORDER,
  VIDEO_PRESETS,
  type AudioPresetId,
  type CodecStrategy,
  type ContentMode,
  type VideoPresetId,
} from "../lib/config";

const CODEC_HINT: Record<CodecStrategy, string> = {
  hardware: "H264 primeiro — encoder da GPU (NVENC/QuickSync). Menor latencia e CPU.",
  eficiencia: "AV1/VP9 primeiro — mesma nitidez com menos banda, custa CPU.",
  compatibilidade: "VP8 primeiro — funciona em qualquer maquina, qualidade menor.",
};

const CONTENT_HINT: Record<ContentMode, string> = {
  jogo: "Segura os FPS quando a rede aperta. Perde nitidez, nunca trava.",
  leitura: "Segura a nitidez do texto. Derruba FPS quando a rede aperta.",
};

function SettingsModalBase() {
  const open = useApp((s) => s.showSettings);
  const tuning = useApp((s) => s.tuning);
  const mics = useApp((s) => s.mics);
  const micDeviceId = useApp((s) => s.micDeviceId);
  const noiseSuppression = useApp((s) => s.noiseSuppression);
  const systemAudio = useApp((s) => s.systemAudio);
  const cameras = useApp((s) => s.cameras);
  const camDeviceId = useApp((s) => s.camDeviceId);
  const speakers = useApp((s) => s.speakers);
  const outputDeviceId = useApp((s) => s.outputDeviceId);
  const outputMode = useApp((s) => s.outputMode);
  const pushToTalk = useApp((s) => s.pushToTalk);
  const overlayEnabled = useApp((s) => s.overlayEnabled);
  const sounds = useApp((s) => s.sounds);
  const updateVersion = useApp((s) => s.updateVersion);
  const updateBusy = useApp((s) => s.updateBusy);

  const [copiado, setCopiado] = useState(false);
  const [sources, setSources] = useState<CaptureSource[]>([]);
  const [source, setSource] = useState("");

  useEffect(() => {
    if (!open || !isDesktop) return;
    void listCaptureSources().then((list) => setSources(list ?? []));
    void getCaptureSource().then((current) => setSource(current ?? ""));
  }, [open]);

  const copiarDiagnostico = async () => {
    const ok = await copiarTexto(await montarRelatorio());
    if (!ok) {
      useApp.getState().toast("error", "Nao foi possivel copiar.");
      return;
    }
    setCopiado(true);
    window.setTimeout(() => setCopiado(false), 2500);
  };

  const chooseSource = async (title: string) => {
    setSource(title);
    await setCaptureSource(title);
    useApp
      .getState()
      .toast("info", "Fonte salva. Reinicie o app para valer.");
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") useApp.setState({ showSettings: false });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;

  return (
    <div className="absolute inset-0 z-50 grid place-items-center bg-black/60 p-6">
      <div className="animate-pop flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-line bg-base-600 shadow-2xl">
        <header className="flex h-12 shrink-0 items-center border-b border-line px-5">
          <h2 className="font-semibold text-ink">Configuracoes de transmissao</h2>
          <button
            onClick={() => useApp.setState({ showSettings: false })}
            className="ml-auto grid size-8 place-items-center rounded text-muted hover:bg-base-500 hover:text-ink"
          >
            <X size={18} />
          </button>
        </header>

        <div className="overflow-y-auto p-5">
          <Section icon={<Gauge size={13} />} title="Qualidade de video">
            <div className="grid grid-cols-2 gap-2">
              {(Object.keys(VIDEO_PRESETS) as VideoPresetId[]).map((id) => (
                <Option
                  key={id}
                  active={tuning.video === id}
                  label={VIDEO_PRESETS[id].label}
                  hint={VIDEO_PRESETS[id].hint}
                  onClick={() => void session.setTuning({ video: id })}
                />
              ))}
            </div>
          </Section>

          <Section icon={<MonitorPlay size={13} />} title="Prioridade da imagem">
            <div className="grid grid-cols-2 gap-2">
              {(["jogo", "leitura"] as ContentMode[]).map((mode) => (
                <Option
                  key={mode}
                  active={tuning.content === mode}
                  label={mode === "jogo" ? "Jogo (framerate)" : "Leitura (nitidez)"}
                  hint={CONTENT_HINT[mode]}
                  onClick={() => void session.setTuning({ content: mode })}
                />
              ))}
            </div>
          </Section>

          <Section icon={<Cpu size={13} />} title="Codec de video">
            <div className="grid gap-2">
              {(Object.keys(CODEC_ORDER) as CodecStrategy[]).map((id) => (
                <Option
                  key={id}
                  active={tuning.codec === id}
                  label={id}
                  hint={CODEC_HINT[id]}
                  onClick={() => void session.setTuning({ codec: id })}
                />
              ))}
            </div>
          </Section>

          <Section icon={<MonitorSmartphone size={13} />} title="Fonte de captura">
            <select
              value={source}
              onChange={(e) => void chooseSource(e.target.value)}
              disabled={!isDesktop}
              className="w-full rounded-md bg-base-500 px-3 py-2 text-sm text-ink-soft outline-none disabled:opacity-50"
            >
              {sources.length === 0 && <option value="">Monitor inteiro (padrao)</option>}
              {sources.map((src) => (
                <option key={src.id || "monitor"} value={src.id}>
                  {src.kind === "window" ? "Janela: " : ""}
                  {src.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-faint">
              O WebView2 nao tem o seletor de tela do Chrome: a fonte vira um argumento
              de linha de comando, lido uma unica vez quando o processo nasce. Por isso a
              troca so vale no proximo boot.
            </p>

            <button
              onClick={() => session.setSystemAudio(!systemAudio)}
              disabled={!isDesktop}
              className={`mt-2 w-full rounded-md border px-3 py-2 text-left transition-colors disabled:opacity-50 ${
                systemAudio
                  ? "border-brand bg-brand/15 text-ink"
                  : "border-transparent bg-base-500/60 text-muted hover:bg-base-500"
              }`}
            >
              <p className="text-sm font-medium">
                Audio do sistema {systemAudio ? "— ligado" : "— desligado"}
              </p>
              <p className="text-xs text-faint">
                Captura o que a placa de som esta tocando, em vez do audio que o
                WebView2 entrega junto da tela — que com jogo em tela cheia costuma
                vir vazio. Vale no proximo compartilhamento.
              </p>
            </button>
          </Section>

          <Section icon={<Camera size={13} />} title="Webcam">
            <select
              value={camDeviceId}
              onChange={(e) => void session.setCamDevice(e.target.value)}
              onFocus={() => void session.refreshDevices()}
              className="w-full rounded-md bg-base-500 px-3 py-2 text-sm text-ink-soft outline-none"
            >
              <option value="default">Dispositivo padrao do sistema</option>
              {cameras.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Camera ${d.deviceId.slice(0, 6)}`}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-faint">
              Camera e tela vao pelo mesmo canal de video — ligar uma desliga a outra.
              Trocar aqui com a camera ja ligada reabre ela no dispositivo novo.
            </p>
          </Section>

          <Section icon={<Gamepad2 size={13} />} title="Overlay em jogo">
            <button
              onClick={() => void session.setOverlayEnabled(!overlayEnabled)}
              disabled={!isDesktop}
              className={`w-full rounded-md border px-3 py-2 text-left transition-colors disabled:opacity-50 ${
                overlayEnabled
                  ? "border-brand bg-brand/15 text-ink"
                  : "border-transparent bg-base-500/60 text-muted hover:bg-base-500"
              }`}
            >
              <p className="text-sm font-medium">
                {overlayEnabled ? "Ligado" : "Desligado"}
              </p>
              <p className="text-xs text-faint">
                Janela flutuante mostrando quem esta falando, por cima de outros
                programas. So em janela/borderless — fullscreen exclusivo cobre ela.
              </p>
            </button>
          </Section>

          <Section icon={<RadioTower size={13} />} title="Push-to-talk">
            <button
              onClick={() => void session.setPushToTalk(!pushToTalk)}
              className={`w-full rounded-md border px-3 py-2 text-left transition-colors ${
                pushToTalk
                  ? "border-brand bg-brand/15 text-ink"
                  : "border-transparent bg-base-500/60 text-muted hover:bg-base-500"
              }`}
            >
              <p className="text-sm font-medium">
                {pushToTalk
                  ? "Ligado — segure a tecla para falar"
                  : "Desligado (microfone sempre aberto)"}
              </p>
              <p className="text-xs text-faint">
                A tecla e capturada no sistema inteiro, entao funciona com o jogo em
                primeiro plano. So fica registrada enquanto esta ligado — ela aparece
                (e troca) em "Atalhos globais", logo abaixo.
              </p>
            </button>
          </Section>

          <Section icon={<Mic size={13} />} title="Audio do microfone">
            <div className="mb-2 grid grid-cols-2 gap-2">
              {(Object.keys(AUDIO_PRESETS) as AudioPresetId[]).map((id) => (
                <Option
                  key={id}
                  active={tuning.audio === id}
                  label={AUDIO_PRESETS[id].label}
                  hint={AUDIO_PRESETS[id].hint}
                  onClick={() => void session.setTuning({ audio: id })}
                />
              ))}
            </div>

            <select
              value={micDeviceId}
              onChange={(e) => void session.setMicDevice(e.target.value)}
              onFocus={() => void session.refreshDevices()}
              className="w-full rounded-md bg-base-500 px-3 py-2 text-sm text-ink-soft outline-none"
            >
              <option value="default">Dispositivo padrao do sistema</option>
              {mics.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Microfone ${d.deviceId.slice(0, 6)}`}
                </option>
              ))}
            </select>

            <button
              onClick={() => void session.setNoiseSuppression(!noiseSuppression)}
              className={`mt-2 w-full rounded-md border px-3 py-2 text-left transition-colors ${
                noiseSuppression
                  ? "border-brand bg-brand/15 text-ink"
                  : "border-transparent bg-base-500/60 text-muted hover:bg-base-500"
              }`}
            >
              <p className="text-sm font-medium">
                Reducao de ruido avancada {noiseSuppression ? "— ligada" : "— desligada"}
              </p>
              <p className="text-xs text-faint">
                RNNoise: rede neural treinada pra separar voz de ruido de fundo (teclado,
                ventoinha) — mais forte que o filtro padrao, custa um pouco mais de CPU.
              </p>
            </button>
          </Section>

          <Section icon={<Volume2 size={13} />} title="Som">
            <div className="mb-2 grid grid-cols-2 gap-2">
              <Option
                active={outputMode === "natural"}
                label="Natural"
                hint="Volume de cada pessoa como veio, sem ajuste automatico."
                onClick={() => session.setOutputMode("natural")}
              />
              <Option
                active={outputMode === "nivelado"}
                label="Nivelado"
                hint="Sobe quem fala baixo e segura quem fala alto — bom com mics desiguais."
                onClick={() => session.setOutputMode("nivelado")}
              />
            </div>

            <select
              value={outputDeviceId}
              onChange={(e) => void session.setOutputDeviceId(e.target.value)}
              onFocus={() => void session.refreshDevices()}
              disabled={!outputSupport.setSinkId}
              className="w-full rounded-md bg-base-500 px-3 py-2 text-sm text-ink-soft outline-none disabled:opacity-50"
            >
              <option value="default">Dispositivo padrao do sistema</option>
              {speakers.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Saida ${d.deviceId.slice(0, 6)}`}
                </option>
              ))}
            </select>
            {!outputSupport.setSinkId && (
              <p className="mt-1 text-xs text-faint">
                Este navegador/runtime nao permite escolher o dispositivo de saida —
                o audio segue pelo fone/caixa padrao do sistema.
              </p>
            )}
          </Section>

          <HotkeysSection open={open} />

          <Section icon={<Bell size={13} />} title="Avisos sonoros">
            <button
              onClick={() => session.setSounds(!sounds)}
              className={`w-full rounded-md border px-3 py-2 text-left transition-colors ${
                sounds
                  ? "border-brand bg-brand/15 text-ink"
                  : "border-transparent bg-base-500/60 text-muted hover:bg-base-500"
              }`}
            >
              <p className="text-sm font-medium">
                {sounds ? "Ligados" : "Desligados"}
              </p>
              <p className="text-xs text-faint">
                Tons curtos quando alguem entra ou sai do canal, e ao ligar ou desligar
                o proprio microfone — util com o jogo em tela cheia.
              </p>
            </button>
          </Section>

          <Section icon={<LifeBuoy size={13} />} title="Diagnostico">
            <button
              onClick={() => void copiarDiagnostico()}
              className="w-full rounded-md bg-base-500/60 px-3 py-2 text-left text-muted transition-colors hover:bg-base-500"
            >
              <p className="text-sm font-medium">
                {copiado ? "Copiado — cole onde for pedir ajuda" : "Copiar diagnostico"}
              </p>
              <p className="text-xs text-faint">
                Versao, sistema, erros desta sessao e falhas do processo nativo. Fica
                so na area de transferencia — nao e enviado para lugar nenhum.
              </p>
            </button>
          </Section>

          <Section icon={<RefreshCw size={13} />} title="Atualizacao">
            <div className="flex items-center gap-2">
              <button
                onClick={() => void session.checkUpdate({ silent: false })}
                disabled={updateBusy || !isDesktop}
                className="rounded-md bg-base-500 px-3 py-2 text-sm text-ink-soft transition-colors enabled:hover:bg-base-400 disabled:opacity-50"
              >
                {updateBusy ? "Verificando..." : "Procurar atualizacao"}
              </button>
              {updateVersion && (
                <button
                  onClick={() => void session.installUpdate()}
                  disabled={updateBusy}
                  className="rounded-md bg-brand px-3 py-2 text-sm font-medium text-white transition-colors enabled:hover:bg-brand-hover disabled:opacity-50"
                >
                  Instalar {updateVersion}
                </button>
              )}
            </div>
          </Section>

          <p className="rounded-md bg-base-500/50 p-3 text-xs leading-relaxed text-muted">
            O bitrate inicial e injetado direto no SDP (x-google-start-bitrate), entao a
            imagem ja abre nitida em vez de subir de 300 kbps ao longo de 15 segundos. No
            modo <b className="text-ink-soft">Jogo</b> o encoder usa
            <b className="text-ink-soft"> maintain-framerate</b>: sob perda de pacote ele
            reduz resolucao, nunca os FPS.
          </p>
        </div>
      </div>
    </div>
  );
}

export const SettingsModal = memo(SettingsModalBase);
