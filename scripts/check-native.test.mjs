import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { embeddedManifests, verifyNative } from './check-native.mjs';

const xml = '<assembly><longPathAware>true</longPathAware><requestedExecutionLevel level="asInvoker" uiAccess="false"/></assembly>';

// PE32+ com uma secao .rsrc. Duplicar o ramo e o caso real do GCC 16 local.
function fixture(manifests) {
  const bytes = Buffer.alloc(8192), pe = 0x80, optional = pe + 24, section = optional + 240;
  bytes.writeUInt32LE(pe, 0x3c); bytes.write('PE\0\0', pe, 'ascii');
  bytes.writeUInt16LE(1, pe + 6); bytes.writeUInt16LE(240, pe + 20);
  bytes.writeUInt16LE(0x20b, optional);
  bytes.writeUInt32LE(0x1000, optional + 112 + 16);
  bytes.writeUInt32LE(7680, section + 8); bytes.writeUInt32LE(0x1000, section + 12);
  bytes.writeUInt32LE(7680, section + 16); bytes.writeUInt32LE(512, section + 20);
  const base = 512;
  bytes.writeUInt16LE(manifests.length, base + 14);
  manifests.forEach((manifest, index) => {
    const branch = 128 + index * 64, data = 512 + index * 16;
    const content = 1024 + index * 1024;
    bytes.writeUInt32LE(24, base + 16 + index * 8);
    bytes.writeUInt32LE((0x80000000 + branch) >>> 0, base + 20 + index * 8);
    bytes.writeUInt16LE(1, base + branch + 14);
    bytes.writeUInt32LE(1, base + branch + 16);
    bytes.writeUInt32LE((0x80000000 + branch + 32) >>> 0, base + branch + 20);
    bytes.writeUInt16LE(1, base + branch + 32 + 14);
    bytes.writeUInt32LE(1033, base + branch + 32 + 16);
    bytes.writeUInt32LE(data, base + branch + 32 + 20);
    bytes.writeUInt32LE(0x1000 + content, base + data);
    bytes.writeUInt32LE(Buffer.byteLength(manifest), base + data + 4);
    bytes.write(manifest, base + content, 'utf8');
  });
  return bytes;
}

function withExecutable(manifests, check) {
  const directory = mkdtempSync(join(tmpdir(), 'voxa-pe-test-'));
  const file = join(directory, 'fixture.exe');
  try { writeFileSync(file, fixture(manifests)); check(file); }
  finally { unlinkSync(file); rmdirSync(directory); }
}

test('PE com manifest unico preserva privilegio e caminhos longos', () => {
  withExecutable([xml], file => {
    assert.equal(embeddedManifests(file)[0].xml, xml);
    assert.deepEqual(verifyNative(file), []);
  });
});
test('manifests duplicados recusam publicacao mesmo se linker gerou executavel', () => {
  withExecutable([xml, xml], file => assert.throws(() => verifyNative(file), /unico manifest/));
});
test('manifest ausente nao passa na validacao', () => {
  withExecutable([], file => assert.throws(() => verifyNative(file), /unico manifest/));
});
test('executavel pedindo administrador nao passa na validacao', () => {
  withExecutable([xml.replace('asInvoker', 'requireAdministrator')], file => assert.throws(() => verifyNative(file), /asInvoker/));
});
test('manifest padrao somente Common Controls bloqueia release', () => {
  withExecutable(['<assembly><dependency>Microsoft.Windows.Common-Controls</dependency></assembly>'],
    file => assert.throws(() => verifyNative(file), /asInvoker/));
});
test('manifest sem suporte a caminhos longos bloqueia release', () => {
  withExecutable([xml.replace('<longPathAware>true</longPathAware>', '')],
    file => assert.throws(() => verifyNative(file), /longPathAware/));
});
test('manifest versionado preserva controles nativos e satisfaz politica do PE', () => {
  const manifest = readFileSync(new URL('../src-tauri/windows-app-manifest.xml', import.meta.url), 'utf8');
  assert.match(manifest, /Microsoft.Windows.Common-Controls/);
  withExecutable([manifest], file => assert.deepEqual(verifyNative(file), []));
});

test('endpoint nativo preserva o contrato camelCase consumido pelo React', () => {
  const source = readFileSync(new URL('../src-tauri/src/native/mod.rs', import.meta.url), 'utf8');
  assert.match(
    source,
    /#\[derive\(Serialize\)\]\s*#\[serde\(rename_all = "camelCase"\)\]\s*pub struct PreparedEndpoint/,
  );
});

test('decoder renegocia NV12 quando o Media Foundation muda o formato', () => {
  const source = readFileSync(new URL('../src-tauri/src/native/decoder.rs', import.meta.url), 'utf8');
  assert.match(source, /MF_E_TRANSFORM_STREAM_CHANGE/);
  assert.match(source, /GetOutputAvailableType\(0, index\)/);
  assert.match(source, /SetOutputType\(0, &candidate, 0\)/);
});
