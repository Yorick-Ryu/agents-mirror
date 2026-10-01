import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('./src/index.js', import.meta.url), 'utf8');
const { deleteOldVersions, syncLatest, syncCodexLatest, syncNodeZips, syncGitForWindows } = await import('data:text/javascript;base64,' + Buffer.from(source + '\nexport {deleteOldVersions,syncLatest,syncCodexLatest,syncNodeZips,syncGitForWindows};').toString('base64'));
function bucket(prefix, current, keys) {
  const deleted = []; let reads = 0;
  return { deleted, env: { CLAUDE_RELEASES: {
    get: async () => ({ text: async () => { reads++; return prefix === 'git/' ? JSON.stringify({version:current}) : current; } }),
    list: async ({cursor}) => ({objects:keys.slice(cursor ? 2 : 0, cursor ? undefined : 2).map(key=>({key})),truncated:!cursor&&keys.length>2,cursor:'next'}),
    delete: async keys => deleted.push(...keys),
  }}};
}
test('all version families retain both current platforms, pointers, unrelated and newer objects', async () => {
  for (const [prefix, pointer, old, current, newer] of [
    ['claude-code-releases/','claude-code-releases/latest','2.1.9','2.1.10','2.1.11'],
    ['npm/','claude-code-releases/latest','2.1.9','2.1.10','2.1.11'],
    ['codex/npm/','codex/latest','0.158.0','0.159.3','0.160.0'],
    ['node/','node/latest','v24.14.0','v24.15.0','v25.0.0'],
    ['git/','git/latest','2.55.0.4','2.55.0.5','2.56.0']
  ]) {
    const oldKeys=[prefix+old+'/x64',prefix+old+'/arm64',prefix+old+'/manifest.json'];
    const b=bucket(prefix,current,[...oldKeys,prefix+current+'/x64',prefix+current+'/arm64',prefix+'latest',prefix+'notes/readme',prefix+newer+'/x64','other/1.0.0/file']);
    assert.equal(await deleteOldVersions(b.env,prefix,current,pointer),3);
    assert.deepEqual(b.deleted,oldKeys);
  }
});
test('invalid targets or stale pointers cannot delete', async()=>{
 const b=bucket('npm/','2.1.11',['npm/2.1.9/file']);
 await assert.rejects(deleteOldVersions(b.env,'npm/','2.1.10','claude-code-releases/latest'),/pointer changed/);
 await assert.rejects(deleteOldVersions(b.env,'','2.1.11','claude-code-releases/latest'),/Invalid/);
 await assert.rejects(deleteOldVersions(b.env,'npm/','../','claude-code-releases/latest'),/Invalid/);
 assert.deepEqual(b.deleted,[]);
});
test('pointer moving during listing prevents cleanup',async()=>{
 const b=bucket('npm/','2.1.10',['npm/2.1.9/file']);let n=0;
 b.env.CLAUDE_RELEASES.get=async()=>({text:async()=>++n===1?'2.1.10':'2.1.11'});
 await assert.rejects(deleteOldVersions(b.env,'npm/','2.1.10','claude-code-releases/latest'),/pointer changed/);
 assert.deepEqual(b.deleted,[]);
});
test('upstream failure does not delete existing artifacts',async()=>{
 const original=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('upstream unavailable')};
 try {for(const sync of [syncLatest,syncCodexLatest,syncNodeZips,syncGitForWindows]){
   const b=bucket('npm/','2.1.10',[]);b.env.CLAUDE_RELEASES.head=async()=>null;
   await assert.rejects(sync(b.env,['win32-x64','win32-arm64']),/upstream unavailable/);
   assert.deepEqual(b.deleted,[]);
 }}finally{globalThis.fetch=original}
});
