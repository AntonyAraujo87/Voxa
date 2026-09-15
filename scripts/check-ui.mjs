import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const port=3297, token='ui-local-test-only';
const compiled=spawnSync(process.execPath,['node_modules/vite/bin/vite.js','build','--outDir','work/ui-build'],{
  env:{...process.env,VITE_SIGNALING_URL:`http://127.0.0.1:${port}`,VITE_SUPABASE_URL:'',VITE_SUPABASE_ANON_KEY:'',VITE_TURN_URLS:''},encoding:'utf8',windowsHide:true,
});
await mkdir('work',{recursive:true});
await writeFile('work/ui-build.log',compiled.stdout+compiled.stderr);
assert.equal(compiled.status,0,'Build da interface de teste');
const signaling=spawn(process.execPath,['server/index.js'],{env:{...process.env,PORT:String(port),VOXA_TOKEN:token,TRUST_PROXY:'0'},stdio:'ignore',windowsHide:true});
const root=resolve('work/ui-build');
const http=createServer(async(req,res)=>{
  try {
    const path=resolve(root,'.'+new URL(req.url,'http://localhost').pathname);
    if(path!==root&&!path.startsWith(root+sep)){res.writeHead(403).end();return;}
    const file=path===root?resolve(root,'index.html'):path;
    res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.html':'text/html','.wasm':'application/wasm','.json':'application/json'})[extname(file)]??'application/octet-stream');
    res.end(await readFile(file));
  }catch{res.writeHead(404).end();}
});
let browser;
const errors=[];
try {
  await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
  for(let i=0;i<50;i++){try{if((await fetch(`http://127.0.0.1:${port}/health`)).ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
  browser=await chromium.launch({headless:true,...(process.platform==='win32'?{executablePath:process.env.VOXA_TEST_BROWSER||'C:/Program Files/Google/Chrome/Application/chrome.exe'}:{}),args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required','--allow-loopback-in-peer-connection','--disable-features=WebRtcHideLocalIpsWithMdns','--disable-background-timer-throttling']});
  const pages=[];
  for(const name of ['AliceTest','BobTest']){
    const context=await browser.newContext({permissions:['microphone','camera'],viewport:{width:1280,height:820}});
    const page=await context.newPage();pages.push(page);
    page.on('pageerror',error=>errors.push(String(error)));
    await page.addInitScript(()=>{
      window.__pcs=[];window.__captured=[];window.__clones=[];
      const clone=MediaStream.prototype.clone;
      MediaStream.prototype.clone=function(){const stream=clone.call(this);window.__clones.push(...stream.getTracks());return stream;};
      const NativePC=window.RTCPeerConnection;
      window.RTCPeerConnection=class extends NativePC{constructor(config){super(config);window.__pcs.push(this);}};
      // Somente a fonte fisica e substituida: grafo de audio, Peer, servidor,
      // negociacao, RTP e players sao os mesmos do produto.
      window.__sources=[];
      navigator.mediaDevices.getUserMedia=async options=>{
        let stream;
        if(options.video){
          const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;
          const ctx=canvas.getContext('2d');let frame=0;
          const draw=()=>{ctx.fillStyle=frame++%2?'#e58331':'#317de5';ctx.fillRect(0,0,640,360);};draw();
          const timer=setInterval(draw,33);stream=canvas.captureStream(30);window.__sources.push(canvas,timer);
        }else{
          const ctx=new AudioContext(),osc=ctx.createOscillator(),gain=ctx.createGain(),dest=ctx.createMediaStreamDestination();
          gain.gain.value=0.15;osc.frequency.value=440;osc.connect(gain).connect(dest);osc.start();await ctx.resume();stream=dest.stream;window.__sources.push(ctx,osc);
        }
        window.__captured.push(...stream.getTracks());return stream;
      };
    });
    await page.goto(`http://127.0.0.1:${http.address().port}`);
    await page.getByPlaceholder('seu nick').fill(name);
    await page.getByRole('button',{name:'Continuar',exact:true}).click();
    await page.getByPlaceholder('deixe vazio se o servidor for aberto').fill(token);
    await page.getByRole('button',{name:'Entrar',exact:true}).click();
    await page.getByRole('button',{name:/^Lounge/}).waitFor();
  }
  const [a,b]=pages;
  const hostile='<img src=x onerror="window.__xss=true"> <script>window.__xss=true</script> @BobTest';
  await a.getByPlaceholder('Conversar em #geral').fill(hostile);
  await a.getByRole('button',{name:'Enviar mensagem',exact:true}).click();
  await b.getByText(/<img src=x onerror/).waitFor();
  assert.equal(await b.evaluate(()=>window.__xss===undefined&&document.querySelector('img[src="x"]')===null),true,'conteudo de chat permanece texto');
  for(const page of pages)await page.getByRole('button',{name:/^Lounge/}).click();
  for(const page of pages)await page.waitForFunction(async()=>{
    const pc=window.__pcs.find(pc=>pc.connectionState==='connected');if(!pc)return false;
    let incoming=0,outgoing=0,energy=0; (await pc.getStats()).forEach(stat=>{if(stat.kind==='audio'){incoming+=stat.bytesReceived??0;outgoing+=stat.bytesSent??0;energy+=stat.type==='inbound-rtp'?(stat.totalAudioEnergy??0):0;}});
    return incoming>100&&outgoing>100&&energy>0;
  },null,{timeout:30000});
  await a.getByTitle('Ligar câmera').click();
  await b.getByRole('button',{name:'Assistir',exact:true}).waitFor();
  await a.waitForFunction(()=>window.__pcs.some(pc=>pc.connectionState==='connected'&&pc.getTransceivers()[1]?.sender.track===null));
  await b.getByRole('button',{name:'Assistir',exact:true}).click();
  await b.waitForFunction(()=>[...document.querySelectorAll('video')].some(video=>video.readyState>=2&&video.videoWidth>0),null,{timeout:15000});
  await b.getByTitle('Ocultar transmissões').click();
  await a.waitForFunction(()=>window.__pcs.some(pc=>pc.connectionState==='connected'&&pc.getTransceivers()[1]?.sender.track===null));
  await a.getByTitle('Desconectar',{exact:true}).click();
  await a.waitForFunction(()=>window.__captured.length>0&&window.__captured.every(track=>track.readyState==='ended'));
  await b.getByTitle('Configuracoes',{exact:true}).click();
  assert.equal(await b.getByRole('dialog',{name:'Configuracoes',exact:true}).evaluate(dialog=>dialog.contains(document.activeElement)),true);
  await b.getByRole('button',{name:'Testar audio e conexao',exact:true}).click();
  await b.getByRole('button',{name:'Testar microfone',exact:true}).click();
  await b.getByText(/Sinal de microfone detectado/).waitFor({timeout:15000});
  assert.equal(await b.evaluate(()=>window.__clones.length>0&&window.__clones.every(track=>track.readyState==='ended')),true,'teste libera apenas seu clone');
  assert.equal(await b.evaluate(()=>window.__captured.every(track=>track.readyState==='live')),true,'teste preserva microfone da chamada');
  await b.getByRole('button',{name:'Testar saida',exact:true}).click();
  await b.getByText(/Tom enviado ao dispositivo de saida escolhido/).waitFor();
  await b.getByRole('button',{name:'Testar microfone',exact:true}).click();
  await b.waitForFunction(()=>window.__clones.some(track=>track.readyState==='live'));
  await b.keyboard.press('Escape');
  await b.getByRole('dialog',{name:'Configuracoes',exact:true}).waitFor({state:'hidden'});
  await b.waitForFunction(()=>window.__clones.every(track=>track.readyState==='ended'));
  assert.equal(await b.evaluate(()=>window.__captured.every(track=>track.readyState==='live')),true,'fechar diagnostico preserva chamada');
  assert.deepEqual(errors,[]);
  await mkdir('test-results',{recursive:true});
  await writeFile('test-results/ui.json',JSON.stringify({status:'PASS',browser:browser.version(),checks:['login-real','chat-XSS-exibido-como-texto','voz-RTP-bidirecional','video-somente-ao-assistir','video-reproduzido','ocultar-interrompe-envio','sair-encerra-captura','foco-dialogo-Escape','teste-microfone-detecta-som','teste-preserva-microfone-chamada','teste-saida-player','fechar-teste-libera-clone'],errors},null,2));
  console.log('PASS: interface de producao + servidor local + duas sessoes + dispositivos sinteticos (12 verificacoes)');
}catch(error){
  console.error(String(error));
  if(browser){const pages=browser.contexts().flatMap(context=>context.pages());for(let i=0;i<pages.length;i++){
    await pages[i].screenshot({path:`work/ui-failure-${i}.png`}).catch(()=>{});
    console.error(JSON.stringify(await pages[i].evaluate(async()=>({text:document.body.innerText,pcs:await Promise.all(window.__pcs.map(async pc=>({state:pc.connectionState,signaling:pc.signalingState,tx:pc.getTransceivers().map(t=>({mid:t.mid,dir:t.currentDirection,send:t.sender.track?.kind,recv:t.receiver.track?.kind,muted:t.receiver.track?.muted})),stats:pc.connectionState==='closed'?[]:[...(await pc.getStats()).values()].filter(s=>s.type==='inbound-rtp'||s.type==='outbound-rtp')}))),videos:[...document.querySelectorAll('video')].map(v=>({ready:v.readyState,width:v.videoWidth,tracks:v.srcObject?.getTracks().map(t=>({kind:t.kind,muted:t.muted,state:t.readyState}))}))}))));
  }}
  process.exitCode=1;
}finally{await browser?.close();signaling.kill();await new Promise(resolve=>http.close(resolve));}
