import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';
import assert from 'node:assert/strict';

// Classe de transmissao real; somente os dispositivos e a malha sao controlados.
const raw=await readFile('src/lib/transmissao.ts','utf8');
const source=raw.replace(/^import\s[\s\S]*?;\r?\n/gm,'');
const {code}=await transform(source,{loader:'ts',format:'cjs',target:'es2022'});
let state, native, options;
const app={getState:()=>state,setState:patch=>Object.assign(state,patch)};
const subject={exports:{}};
new Function('module','useApp','VIDEO_PRESETS','savePrefs','setLocalScreen','focusWindow','isDesktop','iniciarAudioDoSistema','pararAudioDoSistema',code)(subject,app,{alta:{width:1920,height:1080,fps:60}},()=>{},()=>{},async()=>{},true,async(_failure,value)=>{options=value;return native();},()=>{});
const {Transmissao}=subject.exports;
const setup=mode=>{
  state={activeVoice:'lounge',sharing:false,sharingKind:null,systemAudio:true,systemAudioMode:mode,audioProcessId:1234,selfSocketId:'self',tuning:{video:'alta',content:'jogo'},toast(){}};
  const video={kind:'video'}, audio={kind:'audio',stopped:false,stop(){this.stopped=true;}};
  const media={async openScreen(){return{stream:{},video,audio};},closeScreen(){},closeWebcam(){}};
  const mesh={async setScreen(video,audio){this.video=video;this.audio=audio;}};
  return {tx:new Transmissao(media,mesh,{setState(){}}),mesh,audio,video};
};
for(const mode of ['application','exclude-voxa']) {
  const {tx,mesh,audio,video}=setup(mode);
  native=async()=>{throw Error('unsupported Windows');};
  await tx.iniciarTela();
  assert.equal(mesh.video,video);assert.equal(mesh.audio,null);assert.equal(audio.stopped,true);
  assert.equal(state.sharing,true);assert.equal(options.mode,mode);
  tx.pararTela();
}
{
  const {tx,mesh,audio}=setup('system');native=async()=>{throw Error('device busy');};
  await tx.iniciarTela();assert.equal(mesh.audio,audio);assert.equal(audio.stopped,false);tx.pararTela();
}
{
  const {tx,mesh,audio}=setup('application');const scoped={kind:'audio'};native=async()=>scoped;
  await tx.iniciarTela();assert.equal(mesh.audio,scoped);assert.equal(audio.stopped,true);assert.equal(options.processId,1234);tx.pararTela();
}
{
  const {tx,mesh}=setup('application');let release;
  native=()=>new Promise(resolve=>{release=resolve;});
  const opening=tx.iniciarTela();await new Promise(resolve=>setImmediate(resolve));
  tx.pararTela();release({kind:'audio'});await opening;
  assert.equal(mesh.audio,null);assert.equal(mesh.video,null);assert.equal(state.sharing,false);
}
console.log('PASS: falha nunca amplia captura de aplicativo, fallback legado, selecao de processo e cancelamento (5 verificacoes)');
