import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const server=await readFile(new URL('../dnd_chatgpt_server.py',import.meta.url),'utf8');
const app=await readFile(new URL('../assets/app.js',import.meta.url),'utf8');

test('DM contract exposes dedicated scene tools and keeps scene fields out of generic patches',()=>{
  assert.match(server,/"name": "transition_scene"/);
  assert.match(server,/"name": "update_scene"/);
  assert.match(server,/SCENE STATE COMMIT CHECK \(HIGH PRIORITY\):[\s\S]*?call transition_scene/);
  assert.match(server,/AUTHORITATIVE CURRENT SCENE:/);
  assert.match(server,/rsplit\("\.\", 1\)\[-1\]/);
  assert.match(server,/Rain begins outside[\s\S]*?update_scene\(weather=rain\)/);
  assert.ok(app.includes("function handleTool(name,a){name=String(name||'').split('.').at(-1)"));
  const patch=server.match(/"name": "propose_state_patch"[\s\S]*?\n    },/);
  assert.ok(patch);
  assert.doesNotMatch(patch[0],/scene_title|scene_description|location_name|location_id/);
});

test('atmosphere tool contract states that it only presents established world facts',()=>{
  const start=server.indexOf('"name": "set_atmosphere"');
  const tool=server.slice(start,start+2500);
  assert.match(tool,/presentation|visually|established/i);
});
