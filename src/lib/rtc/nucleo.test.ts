import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { tuneSdp, preferVideoCodec } from "../sdp.ts";
import { AdaptiveQuality, DEGRADE_STEPS } from "./adaptive.ts";
import type { PeerStats } from "./types.ts";

/* ---------------------------------------------------------------------------
   Testes do nucleo de RTC — as partes que sao funcao pura e por isso rodam
   sem navegador (Node 24 executa TypeScript direto).

   Cobrem justamente o que quebra CALADO: um SDP mal montado nao lanca erro,
   o navegador so ignora o que nao entendeu e a chamada fica ruim sem
   explicacao. Antes disto, toda validacao dessa camada era manual.
--------------------------------------------------------------------------- */

const SDP_BASE = [
  "v=0",
  "o=- 1 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111 63",
  "c=IN IP4 0.0.0.0",
  "a=rtpmap:111 opus/48000/2",
  "a=rtpmap:63 red/48000/2",
  "m=video 9 UDP/TLS/RTP/SAVPF 96 97 98",
  "c=IN IP4 0.0.0.0",
  "a=rtpmap:96 VP8/90000",
  "a=rtpmap:97 rtx/90000",
  "a=rtpmap:98 H264/90000",
  "a=fmtp:98 profile-level-id=42e01f",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "c=IN IP4 0.0.0.0",
  "a=rtpmap:111 opus/48000/2",
].join("\r\n");

const VIDEO = { startKbps: 8000, minKbps: 2000, maxKbps: 12000 };
const OPUS = { stereo: true, bitrate: 128000, dtx: false, ptimeMs: 20 };

describe("tuneSdp", () => {
  test("aplica start/min/max bitrate em TODOS os codecs de video", () => {
    const out = tuneSdp(SDP_BASE, { video: VIDEO });
    // VP8 e H264 sao os dois codecs reais; rtx nao pode receber fmtp de bitrate
    for (const pt of ["96", "98"]) {
      const linha = out.split("\r\n").find((l) => l.startsWith(`a=fmtp:${pt} `));
      assert.ok(linha, `faltou fmtp do payload ${pt}`);
      assert.match(linha, /x-google-start-bitrate=8000/);
      assert.match(linha, /x-google-min-bitrate=2000/);
    }
    assert.ok(
      !out.includes("a=fmtp:97 x-google"),
      "rtx nao e codec de imagem, nao deve receber bitrate"
    );
  });

  test("preserva parametros que ja existiam no fmtp", () => {
    // H264 chega com profile-level-id; perde-lo faz o outro lado recusar o codec.
    const out = tuneSdp(SDP_BASE, { video: VIDEO });
    const linha = out.split("\r\n").find((l) => l.startsWith("a=fmtp:98 "));
    assert.match(linha ?? "", /profile-level-id=42e01f/);
  });

  test("b=AS vai logo depois do c=, como o RFC exige", () => {
    const linhas = tuneSdp(SDP_BASE, { video: VIDEO }).split("\r\n");
    const c = linhas.findIndex((l, i) => l.startsWith("c=") && linhas[i - 1]?.startsWith("m=video"));
    assert.equal(linhas[c + 1], "b=AS:12000");
    assert.equal(linhas[c + 2], "b=TIAS:12000000");
  });

  test("nao duplica b= quando roda duas vezes", () => {
    // O SDP passa por aqui na oferta E na resposta.
    const uma = tuneSdp(SDP_BASE, { video: VIDEO });
    const duas = tuneSdp(uma, { video: VIDEO });
    assert.equal(duas.split("\r\n").filter((l) => l.startsWith("b=AS:")).length, 1);
  });

  test("mic e audio da tela recebem ajustes independentes", () => {
    const out = tuneSdp(SDP_BASE, {
      micAudio: { ...OPUS, stereo: false, bitrate: 48000 },
      screenAudio: { ...OPUS, stereo: true, bitrate: 256000 },
    });
    const fmtps = out.split("\r\n").filter((l) => l.startsWith("a=fmtp:111 "));
    assert.equal(fmtps.length, 2, "as duas secoes de audio precisam de fmtp");
    assert.match(fmtps[0], /stereo=0/);
    assert.match(fmtps[0], /maxaveragebitrate=48000/);
    assert.match(fmtps[1], /stereo=1/);
    assert.match(fmtps[1], /maxaveragebitrate=256000/);
  });

  test("secao de audio sem ajuste pedido fica intacta", () => {
    const out = tuneSdp(SDP_BASE, { micAudio: OPUS });
    assert.equal(out.split("\r\n").filter((l) => l.startsWith("a=fmtp:111 ")).length, 1);
  });

  test("sdp sem midia nenhuma nao quebra", () => {
    const magro = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n";
    assert.doesNotThrow(() => tuneSdp(magro, { video: VIDEO, micAudio: OPUS }));
  });

  test("termina em CRLF — SDP sem a ultima quebra e recusado", () => {
    assert.ok(tuneSdp(SDP_BASE, { video: VIDEO }).endsWith("\r\n"));
  });
});

describe("preferVideoCodec", () => {
  test("move o codec pedido para a frente sem perder os outros", () => {
    const out = preferVideoCodec(SDP_BASE, "H264");
    const m = out.split("\r\n").find((l) => l.startsWith("m=video"))!;
    const pts = m.split(" ").slice(3);
    assert.equal(pts[0], "98", "H264 deveria estar na frente");
    assert.deepEqual([...pts].sort(), ["96", "97", "98"], "nenhum payload pode sumir");
  });

  test("codec ausente deixa a ordem como estava", () => {
    const out = preferVideoCodec(SDP_BASE, "AV1");
    assert.equal(
      out.split("\r\n").find((l) => l.startsWith("m=video")),
      SDP_BASE.split("\r\n").find((l) => l.startsWith("m=video"))
    );
  });
});

/* ------------------------------ adaptativo -------------------------------- */

const stat = (over: Partial<PeerStats> = {}): PeerStats =>
  ({ lossPct: 0, limitation: "none", ...over }) as PeerStats;

/** O controlador ignora tudo durante o aquecimento; este atalho pula essa janela. */
function aquecido() {
  const a = new AdaptiveQuality();
  a.reset();
  const state = a as unknown as { iniciadoEm: number };
  state.iniciadoEm = Date.now() - 60_000;
  return a;
}

describe("AdaptiveQuality", () => {
  test("nao degrada durante o aquecimento", () => {
    // Os primeiros segundos de uma captura reportam 0 fps e "cpu" so porque o
    // encoder ainda nao produziu keyframe. Reagir a isso jogava toda
    // transmissao direto no pior degrau.
    const a = new AdaptiveQuality();
    a.reset();
    for (let i = 0; i < 10; i++) {
      const d = a.evaluate([stat({ limitation: "cpu", lossPct: 40 })]);
      assert.equal(d.changed, false);
    }
    assert.equal(a.current, DEGRADE_STEPS[0]);
  });

  test("degrada so depois de insistir, nao no primeiro tropeco", () => {
    const a = aquecido();
    assert.equal(a.evaluate([stat({ lossPct: 30 })]).changed, false);
    assert.equal(a.evaluate([stat({ lossPct: 30 })]).changed, false);
    assert.equal(a.evaluate([stat({ lossPct: 30 })]).changed, true);
  });

  test("um pico isolado de perda nao derruba a qualidade", () => {
    const a = aquecido();
    a.evaluate([stat({ lossPct: 30 })]);
    a.evaluate([stat({ lossPct: 0 })]); // recuperou
    a.evaluate([stat({ lossPct: 30 })]);
    a.evaluate([stat({ lossPct: 30 })]);
    assert.equal(a.current, DEGRADE_STEPS[0], "contador de ruins tinha que ter zerado");
  });

  test("o pior par manda na malha", () => {
    // A mesma imagem e codificada uma vez para cada espectador: quem esta com
    // a conexao ruim dita o limite de todo mundo.
    const a = aquecido();
    for (let i = 0; i < 3; i++) {
      a.evaluate([stat({ lossPct: 0 }), stat({ lossPct: 40 }), stat({ lossPct: 0 })]);
    }
    assert.notEqual(a.current, DEGRADE_STEPS[0]);
  });

  test("nunca passa do ultimo degrau", () => {
    const a = aquecido();
    for (let i = 0; i < 100; i++) a.evaluate([stat({ limitation: "cpu" })]);
    assert.equal(a.current, DEGRADE_STEPS[DEGRADE_STEPS.length - 1]);
  });

  test("volta a subir quando a conexao estabiliza, mas devagar", () => {
    const a = aquecido();
    for (let i = 0; i < 3; i++) a.evaluate([stat({ lossPct: 30 })]);
    const pior = a.current;

    // Poucas amostras boas nao bastam — senao ficaria oscilando de resolucao.
    for (let i = 0; i < 5; i++) a.evaluate([stat({ lossPct: 0 })]);
    assert.equal(a.current, pior);

    for (let i = 0; i < 15; i++) a.evaluate([stat({ lossPct: 0 })]);
    assert.notEqual(a.current, pior, "deveria ter recuperado um degrau");
  });

  test("sem pares, nao decide nada", () => {
    const a = aquecido();
    assert.equal(a.evaluate([]).changed, false);
  });

  test("reset volta pro topo e re-arma o aquecimento", () => {
    const a = aquecido();
    for (let i = 0; i < 3; i++) a.evaluate([stat({ lossPct: 30 })]);
    assert.notEqual(a.current, DEGRADE_STEPS[0]);

    a.reset();
    assert.equal(a.current, DEGRADE_STEPS[0]);
    assert.equal(a.evaluate([stat({ lossPct: 90 })]).changed, false, "deveria estar aquecendo");
  });
});
