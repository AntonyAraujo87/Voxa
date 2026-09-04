import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mencionaVoce, partirPorMencao, sugerir, trechoDeMencao } from "./mencao.ts";

/* ---------------------------------------------------------------------------
   Mencao errada e um bug silencioso: ou a pessoa e notificada de conversa que
   nao era com ela, ou — pior — nao e avisada quando alguem chamou. Nenhum dos
   dois aparece como erro em lugar nenhum.
--------------------------------------------------------------------------- */

const ROSTER = ["Ana", "Ana Paula", "Bruno", "Lucas"];

const texto = (partes: ReturnType<typeof partirPorMencao>) =>
  partes.map((p) => (p.tipo === "mencao" ? `[${p.alvo}]` : p.texto)).join("");

describe("partirPorMencao", () => {
  test("marca uma mencao simples e preserva o resto", () => {
    const p = partirPorMencao("oi @Bruno, tudo bem?", ROSTER);
    assert.equal(texto(p), "oi [Bruno], tudo bem?");
  });

  test("prefere o nome mais longo", () => {
    // Com "Ana" e "Ana Paula" no canal, casar o mais curto primeiro mandaria
    // a mencao pra pessoa errada e deixaria " Paula" solto no texto.
    const p = partirPorMencao("@Ana Paula vem ca", ROSTER);
    assert.equal(texto(p), "[Ana Paula] vem ca");
  });

  test("ainda reconhece o nome curto quando o longo nao serve", () => {
    const p = partirPorMencao("@Ana vem ca", ROSTER);
    assert.equal(texto(p), "[Ana] vem ca");
  });

  test("ignora arroba no meio de palavra", () => {
    // Um e-mail nao pode virar mencao ao dominio.
    const p = partirPorMencao("manda pra lucas@ana.com", ROSTER);
    assert.equal(p.length, 1);
    assert.equal(p[0].tipo, "texto");
  });

  test("nome que nao esta no canal fica como texto", () => {
    const p = partirPorMencao("@Fulano apareceu", ROSTER);
    assert.equal(p.length, 1);
    assert.equal(p[0].tipo, "texto");
  });

  test("@todos sempre vale, mesmo sem ninguem com esse nome", () => {
    const p = partirPorMencao("@todos ouviram?", ROSTER);
    assert.equal(texto(p), "[todos] ouviram?");
  });

  test("nao diferencia maiuscula, mas mostra o que foi digitado", () => {
    const p = partirPorMencao("e ai @bRuNo", ROSTER);
    assert.equal(p[1].tipo, "mencao");
    assert.equal(p[1].tipo === "mencao" && p[1].alvo, "Bruno");
    assert.equal(p[1].texto, "@bRuNo", "o texto exibido deve ser o que a pessoa escreveu");
  });

  test("varias mencoes na mesma mensagem", () => {
    const p = partirPorMencao("@Ana e @Bruno, vem", ROSTER);
    assert.equal(texto(p), "[Ana] e [Bruno], vem");
  });

  test("mencao grudada na pontuacao", () => {
    const p = partirPorMencao("(@Lucas)", ROSTER);
    assert.equal(texto(p), "([Lucas])");
  });

  test("texto sem arroba nenhuma vira uma parte so", () => {
    const p = partirPorMencao("mensagem normal", ROSTER);
    assert.deepEqual(p, [{ tipo: "texto", texto: "mensagem normal" }]);
  });

  test("roster vazio nao quebra e @todos continua valendo", () => {
    assert.equal(texto(partirPorMencao("@todos oi", [])), "[todos] oi");
    assert.equal(partirPorMencao("@Ana oi", [])[0].tipo, "texto");
  });
});

describe("mencionaVoce", () => {
  test("pelo nome", () => {
    assert.equal(mencionaVoce("fala @Lucas", "Lucas", ROSTER), true);
  });

  test("por @todos", () => {
    assert.equal(mencionaVoce("@todos reuniao", "Lucas", ROSTER), true);
  });

  test("mencao a outra pessoa nao conta", () => {
    assert.equal(mencionaVoce("fala @Bruno", "Lucas", ROSTER), false);
  });

  test("o nome solto no texto nao conta — precisa da arroba", () => {
    // Senao qualquer conversa citando a pessoa viraria notificacao.
    assert.equal(mencionaVoce("o Lucas falou isso", "Lucas", ROSTER), false);
  });

  test("sem nome definido, nunca menciona", () => {
    assert.equal(mencionaVoce("@todos", "", ROSTER), false);
  });
});

describe("trechoDeMencao", () => {
  test("pega o termo depois da arroba", () => {
    assert.deepEqual(trechoDeMencao("oi @bru", 7), { inicio: 3, termo: "bru" });
  });

  test("arroba sozinha ja abre a lista", () => {
    assert.deepEqual(trechoDeMencao("oi @", 4), { inicio: 3, termo: "" });
  });

  test("aceita um espaco, pra nome composto", () => {
    assert.deepEqual(trechoDeMencao("@Ana Pau", 8), { inicio: 0, termo: "Ana Pau" });
  });

  test("dois espacos fecham: a pessoa voltou a escrever a frase", () => {
    assert.equal(trechoDeMencao("@Ana  vem", 9), null);
  });

  test("quebra de linha fecha", () => {
    assert.equal(trechoDeMencao("@Ana\nvem", 8), null);
  });

  test("sem arroba, nada", () => {
    assert.equal(trechoDeMencao("mensagem", 8), null);
  });

  test("arroba de e-mail nao abre a lista", () => {
    assert.equal(trechoDeMencao("lucas@ana", 9), null);
  });

  test("olha so o que esta ANTES do cursor", () => {
    // Com o cursor no meio do nome, a sugestao tem que considerar so o que
    // foi digitado ate ali — senao a lista filtraria pelo texto inteiro e
    // nao ofereceria nada enquanto a pessoa edita no meio.
    assert.deepEqual(trechoDeMencao("@Ana vem", 2), { inicio: 0, termo: "A" });
  });
});

describe("sugerir", () => {
  test("quem comeca com o termo vem antes de quem so contem", () => {
    const s = sugerir("an", ["Fernando", "Ana", "Ana Paula"]);
    assert.deepEqual(s.slice(0, 2), ["Ana", "Ana Paula"]);
    assert.ok(s.includes("Fernando"), "Fernando contem 'an' e deve aparecer, mas depois");
  });

  test("termo vazio lista todo mundo mais @todos", () => {
    const s = sugerir("", ROSTER);
    assert.equal(s.length, 5);
    assert.ok(s.includes("todos"));
  });

  test("respeita o limite", () => {
    assert.equal(sugerir("", ROSTER, 2).length, 2);
  });
});
