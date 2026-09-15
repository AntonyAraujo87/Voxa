// Regressoes de ciclo de vida: modulos reais, dispositivos e rede controlados.
// Usa os módulos reais com dependências de dispositivo/rede controladas.
import { readFile, writeFile } from 'node:fs/promises';
import { transform } from 'esbuild';
import { spawn } from 'node:child_process';
import { io } from 'socket.io-client';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

const results = [];
const noop = () => {};
const wait = ms => new Promise(r => setTimeout(r, ms));
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { resolve, promise }; };
globalThis.window = { setTimeout, clearTimeout, setInterval, clearInterval, addEventListener: noop, removeEventListener: noop };
globalThis.document = { hidden: false };
globalThis.MediaStream = class { constructor(tracks) { this.tracks = tracks; } getTracks() { return this.tracks; } };
const storage = new Map();
globalThis.localStorage = { getItem: k => storage.get(k) ?? null, setItem: (k,v) => storage.set(k,v) };
globalThis.__auditModules = {};
async function module(path, dependencies = {}) {
  const raw = await readFile(path, 'utf8');
  const source = raw.replace(/^import\s[\s\S]*?;\r?\n/gm, '');
  globalThis.__auditModules[path] = dependencies;
  const prefix = `const {${Object.keys(dependencies).join(',')}} = globalThis.__auditModules[${JSON.stringify(path)}];\n`;
  const { code } = await transform(prefix + source, { loader: 'ts', format: 'esm', target: 'es2022', define: { 'import.meta.env': '{}' } });
  return import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
}
function record(id, observed) { results.push({ id, observed }); }
const config = await module('src/lib/config.ts');
const { IceLease } = await module('src/lib/iceLease.ts');
const prefs = await module('src/lib/prefs.ts');
const mencao = await module('src/lib/mencao.ts');
function create(init) {
  let state;
  const api = { subscribe: () => noop, getState: () => state, setState: p => { state = {...state, ...(typeof p === 'function' ? p(state) : p)}; } };
  state = init(api.setState);
  return api;
}
const { useApp: app } = await module('src/store/store.ts', { create, ...config, ...prefs, ...mencao });
const initialState = app.getState();
let history = async () => [];
const { Chat } = await module('src/lib/chat.ts', { useApp: app, loadMessages: (...args) => history(...args), saveMessage: noop, supabaseEnabled: false, uploadAttachment: noop });
const { Transmissao } = await module('src/lib/transmissao.ts', { ...config, useApp: app, setLocalScreen: noop, savePrefs: noop, focusWindow: noop, isDesktop: false, iniciarAudioDoSistema: noop, pararAudioDoSistema: noop });
let micGate = null;
class LocalMedia {
  hasMic = false; isWebcamOn = false; isSharing = false; enabled = true;
  async openMic() { if (micGate) await micGate.promise; this.hasMic = true; return { id: 'mic', readyState: 'live' }; }
  closeMic() { this.hasMic = false; }
  setMicEnabled(on) { this.enabled = on; }
  async openWebcam() { this.isWebcamOn = true; return { id: 'camera' }; }
  closeWebcam() { this.isWebcamOn = false; }
  closeScreen() { this.isSharing = false; }
}
class Mesh {
  ids = []; tracks = {};
  addPeer(id) { this.ids.push(id); }
  clear() { this.ids = []; }
  setMic(t) { this.tracks.mic = t; }
  async setScreen(v,a) { this.tracks.screen = v; this.tracks.screenAudio = a; }
  async setTuning() {}
  async handleSignal(from) { this.ids.push(from); }
}
let joinGate = null;
let nativePTT = 0;
class Signaling {
  constructor(handlers) { this.handlers = handlers; }
  async joinVoice() { return joinGate ? joinGate.promise : { peers: [] }; }
  async connect() { return { selfId: 'self', roster: [] }; }
  leaveVoice() {} setState() {} async sendChat(message) { return message; }
}
const deps = { ...config, ...prefs, useApp: app, LocalMedia, Mesh, Chat, Signaling, Transmissao, listDevices: async () => ({mics:[],speakers:[],cameras:[]}), loadChannels: async () => config.DEFAULT_CHANNELS, supabaseEnabled: false, watchResume: () => noop, observarHistorico: noop, setGuildToken: noop, pararEfeitos: noop, setPeerStream: noop, clearPeerMedia: noop, registrarErro: noop, aplicarModoSaida: noop, setOutputDevice: noop, setOverlayWindowEnabled: noop, listenEvent: async () => noop, setSoundsEnabled: noop, playJoin: noop, playLeave: noop, playMute: noop, playUnmute: noop, setPushToTalkNative: async () => {nativePTT++;} };
Object.assign(deps, await module('src/lib/sessionUpdates.ts', deps));
Object.assign(deps, await module('src/lib/sessionHotkeys.ts', { ...deps, rebindNative: async () => ({}) }));
let resumeCallback, resumeAudio = async () => {};
Object.assign(deps, {
  watchResume: callback => { resumeCallback = callback; return noop; },
  audioContext: () => ({ resume: () => resumeAudio() }),
});
const { session: base } = await module('src/lib/session.ts', deps);
const fresh = () => { app.setState({...initialState, messages: {}, roster: [], activeVoice: null, muted: false, deafened: false, pushToTalk: false}); micGate = null; joinGate = null; return new base.constructor(); };


let s = fresh();
app.setState({activeVoice:'lounge'}); await s.startWebcam(); s.leaveVoice();
assert.equal(s.media.isWebcamOn,false); assert.equal(s.mesh.tracks.screen,null);
record('camera-stop-on-leave',true);

s=fresh();s.hydrate();s.started=true;
app.setState({activeVoice:'lounge',semMicrofone:true});
let networkRecoveries=0;
const hardware=deferred();resumeAudio=()=>hardware.promise;
s.signaling.recoverNetwork=async()=>true;
s.mesh.recoverNetwork=()=>{networkRecoveries++;};
s.tentarMicrofoneDeNovo=()=>hardware.promise;s.refreshDevices=()=>hardware.promise;
for(let attempt=0;attempt<2;attempt++) {
  const finished=await Promise.race([resumeCallback().then(()=>true),wait(50).then(()=>false)]);
  assert.equal(finished,true,'driver pendente nao bloqueia futuras recuperacoes');
}
assert.equal(networkRecoveries,2);hardware.resolve();await wait(0);resumeAudio=async()=>{};
record('resume-network-independent-of-hardware',true);

s=fresh();micGate=deferred();const join=s.joinVoice('lounge'); await wait(0);s.leaveVoice();micGate.resolve();await join;
assert.equal(app.getState().activeVoice,null);assert.equal(s.mesh.tracks.mic,null);record('join-cancel',true);

s=fresh();joinGate=deferred();const lateAck=s.joinVoice('lounge');await wait(0);s.leaveVoice();joinGate.resolve({peers:[{id:'departed'}]});await lateAck;
assert.deepEqual(s.mesh.ids,[]);record('late-ack',true);

s=fresh();app.setState({activeVoice:'lounge'});micGate=deferred();const opening=s.openMic();s.toggleMute();micGate.resolve();await opening;
assert.equal(s.media.enabled,false);record('mute-during-open',true);

s=fresh();app.setState({activeVoice:'lounge',pushToTalk:true,talking:false});s.toggleDeafen();s.toggleDeafen();s.toggleMute();
assert.equal(s.media.enabled,false);record('ptt-deafen',true);

s=fresh();app.setState({activeVoice:'lounge',roster:[{id:'outsider',voice:'other'}]});s.signaling.handlers.onSignal({from:'outsider',data:{candidate:null}});
assert.deepEqual(s.mesh.ids,[]);record('cross-channel-client',true);

s=fresh();
const original={id:'confirmed',channelId:'geral',authorId:'known',content:'original',createdAt:'2026-09-09T12:00:00Z'};
app.getState().pushMessage(original);
s.signaling.handlers.onChat({...original,content:'forged'});
assert.equal(app.getState().messages.geral[0].content,'original');record('chat-duplicate-cannot-rewrite',true);

const id=prefs.loadPrefs().userId;prefs.savePrefs({name:'Pending'});assert.equal(prefs.loadPrefs().userId,id);assert.equal(prefs.currentPrefs().name,'Pending');
prefs.savePrefs({tuning:{video:'bad'},volumes:{a:Infinity,b:7},outputMode:'bad'});
assert.equal(prefs.currentPrefs().tuning.video,'alta');assert.equal(prefs.currentPrefs().volumes.b,2);assert.equal(prefs.currentPrefs().volumes.a,undefined);record('validated-prefs',true);

fresh();let gate=deferred();history=()=>gate.promise;let chat=new Chat(new Signaling());const load=chat.openChannel('geral');
app.getState().pushMessage({id:'live',channelId:'geral',authorId:'x',content:'live',createdAt:'2026-09-09T12:00:00Z'});
gate.resolve([{id:'old',channelId:'geral',content:'old',createdAt:'2026-09-08T12:00:00Z'}]);await load;
assert.deepEqual(app.getState().messages.geral.map(m=>m.id),['old','live']);record('history-merge',true);
fresh();history=async()=>[original];app.getState().pushMessage({...original,content:'forged'});
await new Chat(new Signaling()).openChannel('geral');
assert.equal(app.getState().messages.geral[0].content,'original');record('history-authoritative',true);
fresh();let calls=0;history=async()=>{calls++;return[];};app.getState().pushMessage({id:'live',channelId:'links'});await new Chat(new Signaling()).openChannel('links');assert.equal(calls,1);record('history-after-live',true);

const {readStats,newSamples}=await module('src/lib/rtc/stats.ts',{EMPTY_SAMPLE:{ts:0,bytes:0,packets:0,lost:0}});
const stats=readStats(new Map([['mic',{type:'outbound-rtp',kind:'audio',mid:'0',bytesSent:5000}],['screen',{type:'outbound-rtp',kind:'audio',mid:'2',bytesSent:0}]]),newSamples(),{});
assert.equal(stats.audioOutBytes,5000);assert.equal(stats.micOutBytes,5000);record('audio-stats-sum',true);

const {FilaPCM}=await module('src/lib/filaPcm.ts');const pcm=new FilaPCM(1,10);pcm.push(new Float32Array(16).fill(1));pcm.pull(new Float32Array(2),new Float32Array(2));pcm.push(new Float32Array(16).fill(2));assert.equal(pcm.disponivel,8);record('partial-overflow',true);

let device=deferred(),deviceCalls=0;const rawTrack={stopped:false};const stream={getTracks:()=>[rawTrack],getAudioTracks:()=>[rawTrack]};const mixed={getTracks:()=>[],getAudioTracks:()=>[{readyState:'live'}]};const node=()=>({connect:noop,disconnect:noop,gain:{value:1}});
const {LocalMedia:ActualLocalMedia}=await module('src/lib/localMedia.ts',{...config,captureMic:()=>{deviceCalls++;return device.promise;},createVoiceDetector:()=>noop,audioContext:()=>({createMediaStreamSource:node,createGain:node,createMediaStreamDestination:()=>({...node(),stream:mixed})}),stopStream:stream=>stream?.getTracks().forEach(t=>t.stopped=true)});
let local=new ActualLocalMedia({onSpeaking:noop});const first=local.openMic('voz','default'),second=local.openMic('voz','default');device.resolve(stream);await Promise.all([first,second]);assert.equal(deviceCalls,1);local.closeMic();assert.equal(rawTrack.stopped,true);record('single-microphone-capture',true);
device=deferred();rawTrack.stopped=false;local=new ActualLocalMedia({onSpeaking:noop});const delayed=local.openMic('voz','default');local.closeMic();device.resolve(stream);assert.equal(await delayed,null);assert.equal(rawTrack.stopped,true);record('late-microphone-disposed',true);

class ControlledSocket extends EventEmitter {
 connected=false;auth={};id='socket';io={reconnection(value){this.enabled=value;},enabled:true};
 connect(){queueMicrotask(()=>{if(this.auth.token==='correct'){this.connected=true;this.emit('connect');}else this.emit('connect_error',new Error('nao autorizado'));});}
 disconnect(){this.connected=false;}
 timeout(){return this;}
 emit(event,...args){if(event==='hello'){args[1](null,{selfId:'self',roster:[]});return true;}return super.emit(event,...args);}
}
const socket=new ControlledSocket();const {Signaling:ActualSignaling}=await module('src/lib/signaling.ts',{IceLease,io:()=>socket,...config});const signaling=new ActualSignaling();await assert.rejects(signaling.connect({id:'test'},'incorrect'));await signaling.connect({id:'test'},'correct');assert.equal(socket.io.enabled,true);signaling.destroy();record('retry-login',true);
prefs.flushPrefs();console.log(JSON.stringify({status:'PASS',tests:results.length,results}));
