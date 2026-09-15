import { useEffect, useRef, useState } from "react";
import { useApp } from "../store/store";
import { session } from "../lib/session";
import { audioContext, captureMic } from "../lib/media";
import { entradaDoBus, estadoSaida } from "../lib/audioOutput";
import { estadoAudioDoSistema } from "../lib/sysaudio";
import { PC_CONFIG, hasTurn } from "../lib/config";
import { pingSignaling } from "../lib/signaling";

/** Testes locais e temporarios. Nunca gravam nem enviam a voz do teste. */
export function AudioChecks() {
  const [busy, setBusy] = useState(false);
  const [level, setLevel] = useState(0);
  const [result, setResult] = useState("Escolha uma etapa. Nenhuma gravacao e salva.");
  const stop = useRef<() => void>(() => {});
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; stop.current(); }, []);

  const begin = () => {
    generation.current++; stop.current(); stop.current = () => {};
    setBusy(true); setLevel(0);
    return generation.current;
  };
  const finish = (token: number, message: string) => {
    if (token !== generation.current) return;
    generation.current++; stop.current(); stop.current = () => {};
    setBusy(false); setLevel(0); setResult(message);
  };

  const microphone = async () => {
    const token = begin();
    let stream: MediaStream | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let analyser: AnalyserNode | null = null;
    let interval = 0, peak = 0;
    const timeout = window.setTimeout(() => finish(token, "Microfone nao respondeu em 10 segundos. Verifique a permissao e o dispositivo."), 10000);
    stop.current = () => { clearTimeout(timeout); clearInterval(interval); source?.disconnect(); analyser?.disconnect(); stream?.getTracks().forEach(track => track.stop()); };
    setResult("Fale por cinco segundos. O teste nao altera mudo ou push-to-talk.");
    try {
      const s = useApp.getState();
      const opened = session.cloneMicrophoneForTest() ?? await captureMic(s.tuning.audio, s.micDeviceId);
      if (token !== generation.current) { opened.getTracks().forEach(track => track.stop()); return; }
      stream = opened;
      const context = audioContext(); await context.resume();
      if (token !== generation.current) return;
      source = context.createMediaStreamSource(stream);
      analyser = context.createAnalyser(); analyser.fftSize = 512; source.connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      let ticks = 0;
      interval = window.setInterval(() => {
        analyser!.getByteTimeDomainData(samples);
        let current = 0;
        for (const value of samples) current = Math.max(current, Math.abs(value - 128) / 128);
        peak = Math.max(peak, current); setLevel(Math.min(100, Math.round(current * 300)));
        if (++ticks >= 50) {
          const state = useApp.getState();
          const hint = state.deafened ? "Voce esta ensurdecido." : state.pushToTalk ? "Na chamada, segure a tecla para falar." : state.muted ? "Na chamada, o microfone continua mudo." : "O envio depende da conexao com o participante.";
          finish(token, `${peak > 0.01 ? "Sinal de microfone detectado." : "Microfone abriu, mas nao detectamos som."} ${hint}`);
        }
      }, 100);
    } catch (error) { finish(token, `Microfone: ${error instanceof Error ? error.message : "falha de captura"}`); }
  };

  const output = async () => {
    const token = begin();
    let oscillator: OscillatorNode | null = null, gain: GainNode | null = null;
    const timeout = window.setTimeout(() => finish(token, "A saida nao respondeu. Confira o dispositivo escolhido."), 5000);
    stop.current = () => { clearTimeout(timeout); try { oscillator?.stop(); } catch {} oscillator?.disconnect(); gain?.disconnect(); };
    try {
      const context = audioContext();
      await context.resume(); if (token !== generation.current) return;
      oscillator = context.createOscillator(); gain = context.createGain();
      oscillator.frequency.value = 440; gain.gain.value = 0.05;
      oscillator.connect(gain); gain.connect(entradaDoBus());
      oscillator.onended = () => {
        const state = estadoSaida();
        finish(token, state.tocando && state.contexto === "running" ? "Tom enviado ao dispositivo de saida escolhido. Confirme se voce ouviu; o app nao consegue verificar seu fone fisicamente." : "O player de saida esta bloqueado. Clique novamente e confira o dispositivo.");
      };
      oscillator.start(); oscillator.stop(context.currentTime + 0.7);
    } catch { finish(token, "Nao foi possivel tocar o tom de teste."); }
  };

  const connection = async () => {
    const token = begin(); setResult("Consultando sinalizacao e procurando caminhos ICE...");
    let pc: RTCPeerConnection | null = null;
    let timer = 0;
    stop.current = () => { clearTimeout(timer); pc?.close(); };
    const types = new Set<string>();
    let health = false;
    const complete = () => finish(token, `Sinalizacao ${health ? "acessivel" : "nao confirmada"}. ${types.has("relay") ? "TURN forneceu um caminho relay." : hasTurn ? "TURN configurado, mas nenhum relay foi obtido neste teste." : "TURN nao configurado."} ${types.has("srflx") ? "STUN respondeu." : "Sem resposta STUN confirmada."} A comunicacao entre redes diferentes exige teste com outro participante.`);
    try {
      pc = new RTCPeerConnection(PC_CONFIG);
      pc.onicecandidate = event => { if (event.candidate?.type) types.add(event.candidate.type); };
      pc.createDataChannel("diagnostico");
      timer = window.setTimeout(complete, 9000);
      void pingSignaling(7000).then(ok => { health = ok; });
      await pc.setLocalDescription(await pc.createOffer());
    } catch { finish(token, "Nao foi possivel iniciar o teste WebRTC."); }
  };

  const transmission = () => {
    const s = useApp.getState();
    if (!s.sharing) { setResult("Inicie um compartilhamento e execute esta etapa para medir a captura e o envio reais."); return; }
    const token = begin();
    const before = estadoAudioDoSistema();
    const initialStats = useApp.getState().stats;
    setResult("Medindo o som da transmissao por tres segundos. Deixe o jogo tocando audio.");
    const timer = window.setTimeout(() => {
      const after = estadoAudioDoSistema();
      const peers = session.estadoEnvio().pares;
      const count = Object.keys(peers).length;
      const current = useApp.getState();
      const sent = Object.entries(current.stats).reduce((total, [id, stat]) => {
        const previous = initialStats[id];
        // Nao confundir contadores acumulados antigos ou resetados com envio
        // no periodo. Novos pares precisam de uma segunda medicao.
        if (!previous?.sampleAt || !stat.sampleAt || stat.sampleAt <= previous.sampleAt) return total;
        return total + Math.max(0, (stat.screenAudioOutBytes ?? 0) - (previous.screenAudioOutBytes ?? 0));
      }, 0);
      const native = after.quadrosComSom > before.quadrosComSom ? "Som nativo detectado." : after.estado === "capturando" ? "Captura nativa aberta, sem som detectado no periodo." : "Sem captura nativa ativa; o audio pode vir do navegador.";
      const delivery = sent > 0 ? `Audio da transmissao enviado: ${Math.ceil(sent / 1024)} KB no periodo. Bytes enviados nao comprovam som audivel.` : "Nao foi confirmado envio de audio da transmissao no periodo. Um participante precisa clicar em Assistir.";
      finish(token, `Captura ${current.sharing ? "ativa" : "encerrada"}. ${current.sharingKind === "camera" ? "A camera usa o microfone da chamada." : `${native} ${delivery}`} ${count} conexao(oes) na malha. Confirme a reproducao com quem assiste.`);
    }, 3000);
    stop.current = () => clearTimeout(timer);
  };

  const button = "rounded bg-base-500 px-3 py-2 text-xs text-ink-soft hover:bg-base-400 disabled:opacity-50";
  return <div className="mt-3 space-y-3 rounded-md border border-line p-3">
    <div className="flex flex-wrap gap-2">
      <button className={button} disabled={busy} onClick={() => void microphone()}>Testar microfone</button>
      <button className={button} disabled={busy} onClick={() => void output()}>Testar saida</button>
      <button className={button} disabled={busy} onClick={() => void connection()}>Testar conexao</button>
      <button className={button} disabled={busy} onClick={transmission}>Testar transmissao</button>
      {busy && <button className={button} onClick={() => finish(generation.current, "Teste encerrado.")}>Parar teste</button>}
    </div>
    <meter aria-label="Nivel do microfone em teste" min={0} max={100} value={level} className="h-2 w-full" />
    <p role="status" className="text-xs leading-relaxed text-muted">{result}</p>
  </div>;
}
