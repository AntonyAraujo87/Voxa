import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

export function importedDlls(file) {
  const bytes=readFileSync(file), header=bytes.readUInt32LE(0x3c);
  assert.equal(bytes.toString('ascii',header,header+4),'PE\0\0');
  const count=bytes.readUInt16LE(header+6), optional=header+24;
  const table=optional+bytes.readUInt16LE(header+20);
  const directory=optional+(bytes.readUInt16LE(optional)===0x20b?112:96);
  const offset=rva=>{
    for(let i=0;i<count;i++){
      const section=table+i*40, address=bytes.readUInt32LE(section+12), size=Math.max(bytes.readUInt32LE(section+8),bytes.readUInt32LE(section+16));
      if(rva>=address&&rva<address+size)return bytes.readUInt32LE(section+20)+rva-address;
    }
    throw new Error('RVA invalido no executavel');
  };
  const imported=bytes.readUInt32LE(directory+8);
  if(!imported)return [];
  const dlls=[];
  for(let position=offset(imported);bytes.readUInt32LE(position+12);position+=20){
    const start=offset(bytes.readUInt32LE(position+12)),end=bytes.indexOf(0,start);
    dlls.push(bytes.toString('ascii',start,end));
  }
  return dlls;
}

/** Le RT_MANIFEST do PE final: o linker pode avisar e ainda gerar um exe ambiguo. */
export function embeddedManifests(file) {
  const bytes = readFileSync(file), header = bytes.readUInt32LE(0x3c);
  assert.equal(bytes.toString('ascii', header, header + 4), 'PE\0\0');
  const optional = header + 24, table = optional + bytes.readUInt16LE(header + 20);
  const count = bytes.readUInt16LE(header + 6);
  const directory = optional + (bytes.readUInt16LE(optional) === 0x20b ? 112 : 96);
  const resourceRva = bytes.readUInt32LE(directory + 16);
  if (!resourceRva) return [];
  const offset = rva => {
    for (let i = 0; i < count; i++) {
      const section = table + i * 40, address = bytes.readUInt32LE(section + 12);
      const size = bytes.readUInt32LE(section + 16);
      if (rva >= address && rva < address + size) return bytes.readUInt32LE(section + 20) + rva - address;
    }
    throw new Error('RVA de recurso invalido');
  };
  const base = offset(resourceRva), manifests = [];
  const walk = (position, path = []) => {
    assert.ok(path.length < 3, 'Arvore de recursos invalida');
    const entries = bytes.readUInt16LE(position + 12) + bytes.readUInt16LE(position + 14);
    for (let i = 0; i < entries; i++) {
      const entry = position + 16 + i * 8;
      const id = bytes.readUInt32LE(entry), value = bytes.readUInt32LE(entry + 4);
      const next = [...path, id];
      if (next[0] !== 24) continue;
      if (value >>> 31) walk(base + (value & 0x7fffffff), next);
      else {
        assert.equal(next.length, 3, 'Manifest sem idioma');
        const data = base + value, start = offset(bytes.readUInt32LE(data));
        const length = bytes.readUInt32LE(data + 4);
        assert.ok(start + length <= bytes.length, 'Manifest truncado');
        manifests.push({ path: next, xml: bytes.toString('utf8', start, start + length) });
      }
    }
  };
  walk(base);
  return manifests;
}

export function verifyNative(file, installerManifest) {
  const manifests = embeddedManifests(file);
  assert.equal(manifests.length, 1, 'O executavel deve conter um unico manifest; confira o toolchain antes de distribuir');
  assert.match(manifests[0].xml, /requestedExecutionLevel\s+[^>]*level=["']asInvoker["']/);
  assert.match(manifests[0].xml, /<longPathAware>true<\/longPathAware>/);
  const dlls=importedDlls(file);
  if(dlls.some(name=>name.toLowerCase()==='webview2loader.dll')) {
    if(installerManifest) assert.match(readFileSync(installerManifest,'utf8'), /File[^\r\n]*\/oname=WebView2Loader\.dll/i);
    else assert.ok(existsSync(join(dirname(file),'WebView2Loader.dll')), 'WebView2Loader.dll ausente ao lado do executavel');
  }
  return dlls;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) console.log(JSON.stringify({status:'PASS',imports:verifyNative(process.argv[2],process.argv[3])}));
