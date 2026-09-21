import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

export const compareTags = (a,b)=>{const left=a.slice(1).split('.').map(Number),right=b.slice(1).split('.').map(Number);for(let i=0;i<3;i++){if(left[i]!==right[i])return left[i]-right[i];}return 0;};
export function releaseForTag(releases, tag) {
  const matches = releases.filter(release => release.tag_name === tag);
  assert.equal(matches.length, 1, `Release ${tag} ausente ou duplicada`);
  return matches[0];
}

function promote() {
const repo = process.env.GITHUB_REPOSITORY, tag = process.env.GITHUB_REF_NAME;
assert.match(tag ?? '', /^v\d+\.\d+\.\d+$/);
assert.match(repo ?? '', /^[\w.-]+\/[\w.-]+$/);
const gh = (...args) => execFileSync('gh', args, {encoding:'utf8'});
// O endpoint /releases/tags/:tag devolve 404 para draft em alguns contextos
// do GITHUB_TOKEN. A listagem autenticada inclui drafts criados neste job.
const releases=JSON.parse(gh('api','--paginate','--slurp',`repos/${repo}/releases?per_page=100`)).flat();
const current = releaseForTag(releases, tag);
assert.ok(current.assets.some(asset => asset.name === 'latest.json'), 'Sem manifesto de atualizacao');
assert.ok(current.assets.some(asset => /setup\.exe$/.test(asset.name)), 'Sem instalador');
const newer=releases.some(release=>!release.draft&&!release.prerelease&&/^v\d+\.\d+\.\d+$/.test(release.tag_name)&&compareTags(release.tag_name,tag)>0);
gh('api','--method','PATCH',`repos/${repo}/releases/${current.id}`,'-F','draft=false','-f',`make_latest=${newer?'false':'true'}`);
console.log(`${tag} publicado; latest=${!newer}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) promote();
