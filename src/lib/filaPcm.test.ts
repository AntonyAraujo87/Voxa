import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { FilaPCM } from "./filaPcm.ts";

/* ---------------------------------------------------------------------------
   A fila entre o IPC e a placa de som. Testavel porque um erro aqui nao lanca
   nada — vira estalo, atraso ou silencio, e a unica forma de perceber seria
   alguem reclamando que "o som ta estranho".
--------------------------------------------------------------------------- */

/** Bloco de 20 ms estereo onde cada quadro carrega seu numero de ordem. */
function bloco(inicio: number, quadros = 960): Float32Array {
  const a = new Float32Array(quadros * 2);
  for (let i = 0; i < quadros; i++) {
    a[i * 2] = inicio + i;
    a[i * 2 + 1] = inicio + i;
  }
  return a;
}

function drenar(fila: FilaPCM, chamadas: number): number[] {
  const saida: number[] = [];
  for (let c = 0; c < chamadas; c++) {
    const esq = new Float32Array(128);
    const dir = new Float32Array(128);
    fila.pull(esq, dir);
    saida.push(...esq);
  }
  return saida;
}

describe("FilaPCM", () => {
  test("nao toca antes de juntar folga — senao o primeiro atraso ja estala", () => {
    const f = new FilaPCM();
    f.push(bloco(0)); // 20 ms, abaixo do minimo de 60 ms
    const saida = drenar(f, 4);
    assert.ok(
      saida.every((v) => v === 0),
      "deveria estar em silencio ate acumular"
    );
  });

  test("entrega as amostras na ordem, sem pular nem repetir", () => {
    const f = new FilaPCM();
    let n = 0;
    for (let i = 0; i < 10; i++) {
      f.push(bloco(n));
      n += 960;
    }

    const saida = drenar(f, 60); // 7680 quadros
    assert.equal(saida[0], 0, "deveria comecar do inicio");
    for (let i = 1; i < saida.length; i++) {
      assert.equal(saida[i], saida[i - 1] + 1, `descontinuidade no indice ${i}`);
    }
  });

  test("atravessa a fronteira entre blocos sem emendar errado", () => {
    // O bug classico de fila de audio mora exatamente aqui.
    const f = new FilaPCM(0); // sem espera, para ir direto ao ponto
    f.push(bloco(0, 100));
    f.push(bloco(100, 100));
    // Duas chamadas de 128 cobrem os 200 quadros; o resto vira silencio.
    const saida = drenar(f, 2).slice(0, 200);
    for (let i = 1; i < saida.length; i++) {
      assert.equal(saida[i], saida[i - 1] + 1, `emenda errada no indice ${i}`);
    }
  });

  test("descarta o passado quando atrasa demais", () => {
    const f = new FilaPCM();
    // 60 blocos = 1,2 s, muito acima do teto de 400 ms
    for (let i = 0; i < 60; i++) f.push(bloco(i * 960));

    const ms = (f.disponivel / 48000) * 1000;
    assert.ok(ms <= 400, `guardou ${ms.toFixed(0)}ms, o teto e 400ms`);
    assert.ok(ms > 300, `guardou so ${ms.toFixed(0)}ms — descartou demais`);
  });

  test("fila seca vira silencio, nao estalo em laco", () => {
    const f = new FilaPCM();
    for (let i = 0; i < 4; i++) f.push(bloco(i * 960)); // 80 ms

    const saida = drenar(f, 60); // pede 160 ms, o dobro do que tem
    assert.equal(f.disponivel, 0);
    // O fim tem que ser silencio limpo, nao repeticao do ultimo pedaco.
    assert.ok(
      saida.slice(-128).every((v) => v === 0),
      "deveria terminar em silencio"
    );
  });

  test("volta a tocar depois de secar e receber audio novo", () => {
    const f = new FilaPCM();
    for (let i = 0; i < 4; i++) f.push(bloco(0));
    drenar(f, 60); // seca

    for (let i = 0; i < 5; i++) f.push(bloco(500 + i * 960));
    const saida = drenar(f, 20);
    assert.ok(
      saida.some((v) => v !== 0),
      "deveria ter voltado a tocar"
    );
  });

  test("bloco vazio nao quebra nem trava a fila", () => {
    const f = new FilaPCM(0);
    f.push(new Float32Array(0));
    f.push(bloco(7, 10));
    assert.doesNotThrow(() => drenar(f, 1));
  });

  test("o codigo do worklet gera a partir da propria classe", () => {
    // O AudioWorklet recebe `FilaPCM.toString()` como texto. Se a classe
    // passasse a depender de algo de fora (helper do compilador, import), o
    // worklet quebraria em runtime sem erro de tipo nenhum — e o audio
    // simplesmente nao sairia.
    const fonte = FilaPCM.toString();
    assert.match(fonte, /class FilaPCM/);
    assert.match(fonte, /push\(/);
    assert.match(fonte, /pull\(/);
    assert.ok(
      !/\bimport\b|\brequire\(|__decorate|__extends/.test(fonte),
      "a classe nao pode depender de nada externo para virar worklet"
    );
    assert.doesNotThrow(
      () => new Function(`${fonte}; return new FilaPCM();`)(),
      "o texto gerado precisa ser JavaScript valido por conta propria"
    );
  });
});
