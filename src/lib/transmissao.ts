import { VIDEO_PRESETS } from "./config";
import type { LocalMedia } from "./localMedia";
import type { Mesh } from "./rtc";
import type { Signaling } from "./signaling";
import { useApp } from "../store/store";
import { setLocalScreen } from "../store/mediaStore";
import { savePrefs } from "./prefs";
import { focusWindow, isDesktop } from "./desktop";
import { iniciarAudioDoSistema, pararAudioDoSistema } from "./sysaudio";

const app = useApp;

/* ---------------------------------------------------------------------------
   O canal de video: tela OU camera.

   Existe como modulo proprio por causa de uma regra que nao e obvia e que ja
   custou dois bugs: tela e camera compartilham o MESMO transceiver de video
   da malha. So uma pode estar no ar, e trocar de uma para a outra e desligar
   uma e ligar a outra — nao dois cliques do usuario.

   Foi por confundir "estou transmitindo" com "estou transmitindo TELA" que
   trocar de camera para tela nao saia do lugar: `sharing` fica true nos dois
   casos, entao o guard precisa olhar `sharingKind`.

   Sai da Session porque la a mesma limpeza de estado estava escrita duas
   vezes, uma em cada `stop*` — e o dia em que uma das copias mudasse sem a
   outra, o sintoma seria um icone de transmissao aceso sem transmissao
   nenhuma por tras.
--------------------------------------------------------------------------- */

export class Transmissao {
  /** Trava contra clique duplo: a captura e assincrona, e sem isto dois
   *  cliques rapidos (ou o atalho global repetido) abririam duas capturas e
   *  vazariam um stream que ninguem mais desliga. */
  private telaPendente = false;
  private cameraPendente = false;

  constructor(
    private media: LocalMedia,
    private mesh: Mesh,
    private signaling: Signaling
  ) {}

  /* --------------------------------- tela -------------------------------- */

  async iniciarTela() {
    const s = app.getState();
    if (s.sharingKind === "tela" || this.telaPendente) return;
    if (!s.activeVoice) {
      s.toast("info", "Entre num canal de voz antes de compartilhar.");
      return;
    }
    if (this.media.isWebcamOn) this.pararCamera();

    this.telaPendente = true;
    try {
      const { stream, video, audio } = await this.media.openScreen(s.tuning.video, s.tuning.content);
      setLocalScreen(stream);

      // O audio do getDisplayMedia costuma vir vazio com jogo em tela cheia — e
      // o WebView2 nem sempre entrega alguma coisa. Com a opcao ligada, pega
      // direto o que a placa de som esta tocando (WASAPI loopback).
      let trilhaAudio = audio;
      if (s.systemAudio) {
        try {
          trilhaAudio = (await iniciarAudioDoSistema()) ?? audio;
        } catch (err) {
          // Falhar aqui nao pode cancelar a transmissao: segue com o audio que
          // o navegador deu (mesmo que seja nenhum) e avisa.
          s.toast("info", `Audio do sistema indisponivel: ${(err as Error).message}`);
        }
      }
      await this.mesh.setScreen(video, trilhaAudio);
      this.marcarNoAr("tela");

      const preset = VIDEO_PRESETS[s.tuning.video];
      s.toast("ok", `Compartilhando ${preset.width}x${preset.height} @ ${preset.fps}fps`);
    } catch (err) {
      this.media.closeScreen();
      pararAudioDoSistema();
      setLocalScreen(null);
      s.toast("error", (err as Error).message);
    } finally {
      this.telaPendente = false;
    }
  }

  pararTela() {
    if (!this.media.isSharing) return;
    void this.mesh.setScreen(null, null);
    this.media.closeScreen();
    pararAudioDoSistema();
    this.encerrar();
  }

  /**
   * Abre o seletor de fonte antes de compartilhar — como todo mundo espera,
   * ao estilo Discord. No navegador (dev/teste) nao precisa de seletor
   * proprio: getDisplayMedia() ja mostra o seletor nativo do Chrome sozinho.
   * No app empacotado, o WebView2 nao tem esse seletor embutido — por isso
   * existe o SharePicker, que escolhe ANTES de chamar getDisplayMedia().
   */
  async alternarTela() {
    if (app.getState().sharingKind === "tela") {
      this.pararTela();
      return;
    }
    if (!isDesktop) {
      await this.iniciarTela();
      return;
    }
    // O atalho global pode disparar com a janela escondida na bandeja; o
    // seletor precisa estar visivel para poder escolher.
    await focusWindow();
    app.setState({ showSharePicker: true });
  }

  /* -------------------------------- camera ------------------------------- */

  async iniciarCamera() {
    const s = app.getState();
    if (this.media.isWebcamOn || this.cameraPendente) return;
    if (!s.activeVoice) {
      s.toast("info", "Entre num canal de voz antes de ligar a camera.");
      return;
    }
    if (s.sharing) this.pararTela();

    this.cameraPendente = true;
    try {
      const track = await this.media.openWebcam(s.camDeviceId);
      if (!track) return;
      setLocalScreen(new MediaStream([track]));
      await this.mesh.setScreen(track, null);
      this.marcarNoAr("camera");
    } catch (err) {
      this.media.closeWebcam();
      setLocalScreen(null);
      s.toast("error", (err as Error).message);
    } finally {
      this.cameraPendente = false;
    }
  }

  pararCamera() {
    if (!this.media.isWebcamOn) return;
    void this.mesh.setScreen(null, null);
    this.media.closeWebcam();
    this.encerrar();
  }

  alternarCamera() {
    if (this.media.isWebcamOn) this.pararCamera();
    else void this.iniciarCamera();
  }

  async trocarCamera(deviceId: string) {
    app.setState({ camDeviceId: deviceId });
    savePrefs({ camDeviceId: deviceId });
    if (!this.media.isWebcamOn) return;
    this.pararCamera();
    await this.iniciarCamera();
  }

  /* -------------------------------- estado ------------------------------- */

  /** Liga o estado local e avisa a sala. O `sharingKind` viaja junto de
   *  proposito: sem ele, quem reconecta ve icone de monitor para uma camera. */
  private marcarNoAr(tipo: "tela" | "camera") {
    app.setState({ sharing: true, sharingKind: tipo, focusPeer: app.getState().selfSocketId });
    this.signaling.setState({ sharing: true, sharingKind: tipo });
  }

  /** Desliga o estado local e avisa a sala — a mesma limpeza para tela e
   *  camera, escrita uma vez so. */
  private encerrar() {
    setLocalScreen(null);
    const selfId = app.getState().selfSocketId;
    app.setState((s) => ({
      sharing: false,
      sharingKind: null,
      // So solta o foco se ele estava em mim: tirar o foco de outra pessoa
      // porque EU parei de transmitir seria mudar a tela de quem assiste.
      focusPeer: s.focusPeer === selfId ? null : s.focusPeer,
    }));
    this.signaling.setState({ sharing: false, sharingKind: null });
  }
}
