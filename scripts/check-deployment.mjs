// Leitura publica e limitada: certificado TLS e metadados de /health.
// Nao envia mensagens, nao autentica e nao imprime corpo/respostas privadas.
import https from 'node:https';
import { mkdir, writeFile } from 'node:fs/promises';

const endpoints=[
  'https://voxa-signaling.onrender.com/health',
  'https://qqnpporyphqycuzxucwz.supabase.co/auth/v1/health',
];
const read=url=>new Promise(resolve=>{
  const started=Date.now();let metadata={url};
  const req=https.get(url,{timeout:90000},res=>{
    let body='';res.setEncoding('utf8');
    res.on('data',part=>{body+=part;if(body.length>16384)req.destroy(new Error('response-too-large'));});
    res.on('end',()=>{
      let keys=[];try{keys=Object.keys(JSON.parse(body));}catch{}
      resolve({...metadata,status:res.statusCode,elapsedMs:Date.now()-started,responseKeys:keys});
    });
  });
  req.on('socket',socket=>socket.once('secureConnect',()=>{
    const cert=socket.getPeerCertificate();
    metadata={...metadata,tls:socket.getProtocol(),authorized:socket.authorized,certificateExpires:cert.valid_to};
  }));
  req.on('timeout',()=>req.destroy(new Error('timeout')));
  req.on('error',error=>resolve({...metadata,error:error.code??error.message,elapsedMs:Date.now()-started}));
});
const results=await Promise.all(endpoints.map(read));
await mkdir('test-results',{recursive:true});
await writeFile('test-results/deployment.json',JSON.stringify({at:new Date().toISOString(),results},null,2));
console.log(JSON.stringify(results,null,2));
if(results.some(result=>result.error||!result.authorized))process.exitCode=1;
