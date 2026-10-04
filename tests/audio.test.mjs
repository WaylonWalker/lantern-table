import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isSafeCatalogPath, validateAudioAction, validateCatalog, sanitizeSharedAudioState } from '../assets/audio-core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(await readFile(path.join(root, 'assets/audio/catalog.json'), 'utf8'));

test('catalog is CC0, unique, path-safe, hashed, and points to real bundled files', async () => {
  assert.equal(validateCatalog(catalog), true);
  assert.equal(new Set(catalog.sounds.map(item => item.id)).size, catalog.sounds.length);
  for (const item of catalog.sounds) {
    assert.equal(item.license, 'CC0-1.0');
    assert.equal(item.sourceLicense, 'CC0-1.0');
    const bytes = await readFile(path.join(root, item.file.slice(1)));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha256, item.id);
  }
  const audioFiles = [];
  const { readdir } = await import('node:fs/promises');
  async function walk(dir) { for (const entry of await readdir(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) await walk(file); else if (/\.(ogg|mp3|m4a|webm)$/i.test(entry.name)) audioFiles.push(file); } }
  await walk(path.join(root, 'assets/audio'));
  for (const file of audioFiles) assert.ok(catalog.sounds.some(item => path.join(root, item.file.slice(1)) === file), `unprovenanced asset ${file}`);
});

test('catalog action validator accepts only known cues on the correct channel', () => {
  assert.deepEqual(validateAudioAction({ action: 'play_sfx', cue_id: 'door.knock.heavy' }, catalog.sounds), { action: 'play_sfx', cueId: 'door.knock.heavy', channel: 'sfx' });
  assert.equal(validateAudioAction({ action: 'set_music', cue_id: 'missing.cue' }, catalog.sounds), null);
  assert.equal(validateAudioAction({ action: 'set_music', cue_id: 'https://example.com/a.mp3' }, catalog.sounds), null);
  assert.equal(validateAudioAction({ action: 'set_music', cue_id: '../../secret.mp3' }, catalog.sounds), null);
  assert.equal(validateAudioAction({ action: 'set_music', cue_id: 'door.knock.heavy' }, catalog.sounds), null);
  assert.equal(validateAudioAction({ action: 'fetch_url', cue_id: 'music.battle' }, catalog.sounds), null);
});

test('catalog paths reject traversal and arbitrary URLs', () => {
  assert.equal(isSafeCatalogPath('/assets/audio/sfx/a.ogg'), true);
  assert.equal(isSafeCatalogPath('/assets/audio/../../secret.mp3'), false);
  assert.equal(isSafeCatalogPath('https://example.com/sound.mp3'), false);
});

test('AI audio tool is structured and constrained to the catalog', async () => {
  const code = "import ast,json; tree=ast.parse(open('dnd_chatgpt_server.py',encoding='utf8').read()); node=next(n for n in tree.body if isinstance(n,ast.AnnAssign) and isinstance(n.target,ast.Name) and n.target.id=='DM_TOOLS'); tools=ast.literal_eval(node.value); print(json.dumps(next(t for t in tools if t['name']=='play_audio')));";
  const output = execFileSync('python', ['-c', code], { cwd: root, encoding: 'utf8' });
  const tool = JSON.parse(output);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.deepEqual(tool.parameters.required, ['action', 'cue_id', 'reason']);
  const cues = tool.parameters.properties.cue_id.enum.filter(Boolean);
  assert.deepEqual(new Set(cues), new Set(catalog.sounds.map(item => item.id)));
  assert.ok(tool.parameters.properties.action.enum.includes('stop_music'));
});


test('snapshot audio contains current loops and never stores one shot events', () => {
  const shared = sanitizeSharedAudioState({ ambience: { cueId: 'ambience.cavern', fadeMs: 1500 }, music: { cueId: 'music.battle', fadeMs: 900 }, recentSfx: ['door.knock.heavy'] }, catalog.sounds);
  assert.deepEqual(shared, { ambience: { cueId: 'ambience.cavern', fadeMs: 1500 }, music: { cueId: 'music.battle', fadeMs: 900 } });
  assert.deepEqual(Object.keys(shared), ['ambience', 'music']);
  assert.equal(sanitizeSharedAudioState({ ambience: { cueId: 'music.battle' } }, catalog.sounds).ambience.cueId, null);
});

test('multiplayer relay allows host audio cues but rejects player audio cues', async () => {
  const code = "import ast,json; tree=ast.parse(open('dnd_chatgpt_server.py',encoding='utf8').read()); names={'host_to_players','player_to_host'}; out={}; [out.update({n.targets[0].id:sorted(ast.literal_eval(n.value))}) for n in ast.walk(tree) if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id in names for t in n.targets)]; print(json.dumps(out));";
  const acl = JSON.parse(execFileSync('python', ['-c', code], { cwd: root, encoding: 'utf8' }));
  assert.ok(acl.host_to_players.includes('audio_cue'));
  assert.ok(!acl.player_to_host.includes('audio_cue'));
});
