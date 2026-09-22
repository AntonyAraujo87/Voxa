import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { io } from "socket.io-client";

async function freePort() {
  return new Promise((resolve, reject) => {
    const server=createServer(); server.once("error",reject); server.listen(0,"127.0.0.1",()=>{const {port}=server.address();server.close(error=>error?reject(error):resolve(port));});
  });
}
function emit(socket,event,payload){return new Promise((resolve,reject)=>socket.timeout(3000).emit(event,payload,(error,response)=>error?reject(error):resolve(response)));}
async function waitHealth(url){for(let i=0;i<100;i++){try{if((await fetch(`${url}/health`)).ok)return;}catch{} await new Promise(resolve=>setTimeout(resolve,100));}throw new Error("server did not start");}

test("real signaling pairs host and viewer without relaying media", {timeout:15_000}, async () => {
  const port=await freePort(); const url=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,["server/index.js"],{cwd:process.cwd(),env:{...process.env,PORT:String(port),VOXA_TOKEN:"test-room",TRUST_PROXY:"0"},stdio:"ignore"});
  const sockets=[];
  try {
    await waitHealth(url);
    const connect=()=>new Promise((resolve,reject)=>{const socket=io(url,{transports:["websocket"],auth:{token:"test-room"}});sockets.push(socket);socket.once("connect",async()=>{try{assert.equal((await emit(socket,"hello",{})).ok,true);resolve(socket);}catch(error){reject(error);}});socket.once("connect_error",reject);});
    const attacker=await connect();
    const reflected=await emit(attacker,"stream:join",{room:"attack",role:"host",endpoint:"203.0.113.55:41000",localEndpoint:"192.168.1.50:41000",publicKey:"a".repeat(43)});
    assert.match(reflected.error,/corresponde/);
    const host=await connect(); const viewer=await connect();
    assert.equal((await emit(host,"stream:join",{room:"race",role:"host",endpoint:"127.0.0.1:41000",localEndpoint:"192.168.1.10:41000",publicKey:"h".repeat(43)})).ok,true);
    const hostAnnouncement=new Promise(resolve=>host.once("stream:peer",resolve));
    const joined=await emit(viewer,"stream:join",{room:"race",role:"viewer",endpoint:"127.0.0.1:42000",localEndpoint:"192.168.1.20:42000",publicKey:"v".repeat(43)});
    const announced=await hostAnnouncement;
    assert.equal(joined.peer.endpoint,"192.168.1.10:41000"); assert.equal(announced.endpoint,"192.168.1.20:42000");
    assert.equal(joined.peer.publicKey,"h".repeat(43)); assert.equal(announced.publicKey,"v".repeat(43));
    assert.equal("sessionKey" in joined.peer,false);
  } finally { for(const socket of sockets)socket.disconnect(); child.kill(); }
});
