import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {normalizeSpeech,compileKittenSpeech,renderSpeechParts,assignVoice,speechPlainText} from '../assets/speech.mjs';

test('semantic expression compiles at the Kitten adapter and displays as semantic transcript content',()=>{
  const speech=normalizeSpeech({emotion:'stern',energy:.72,parts:[{type:'text',text:'I told you '},{type:'emphasis',text:'never'},{type:'text',text:' to open that door.'},{type:'event',event:'sigh'},{type:'event',event:'mysterious'}]});
  assert.equal(compileKittenSpeech(speech),'[stern] I told you (((never))) to open that door. <sigh>');
  assert.equal(speechPlainText(speech),'I told you never to open that door.');
  assert.match(renderSpeechParts(speech),/<strong class="speech-emphasis">never<\/strong>/);
  assert.match(renderSpeechParts(speech),/class="speech-event"/);
  assert.doesNotMatch(compileKittenSpeech({parts:[{type:'event',event:'mysterious'}]}),/mysterious/);
});

test('voice assignment uses the runtime catalogue and prefers unused voices',()=>{
  const roster=[{voice:{voice_id:'Luna'}},{voice:null}];
  const voice=assignVoice(['Luna','Victor'],roster,roster[1],'quiet and restrained');
  assert.equal(voice.engine,'kitten2');assert.equal(voice.voice_id,'Victor');assert.equal(voice.base_energy,.38);assert.equal(voice.assigned_at_creation,true);
});

test('replay playback state is attached to the one visible transcript message node',async()=>{
  const [app,html,worker]=await Promise.all([readFile(new URL('../assets/app.js',import.meta.url),'utf8'),readFile(new URL('../dnd_localfirst_demo.html',import.meta.url),'utf8'),readFile(new URL('../assets/kitten_worker.py',import.meta.url),'utf8')]);
  assert.equal((html.match(/id="narrationFollower"/g)||[]).length,0);
  assert.match(app,/card\.dataset\.utteranceId=m\.utterance_id\|\|m\.id/);
  assert.match(app,/card\.classList\.toggle\('is-speaking',activeTranscriptMessageId===m\.id\)/);
  assert.match(app,/activeTranscriptMessageId=message\.id;renderTranscript\(\)/);
  assert.match(app,/message\.speech\?replayActorSpeech\(message\):narrator\.playText\(message\.text,message\.id\)/);
  assert.match(app,/card\.dataset\.utteranceId=m\.utterance_id\|\|m\.id/);
  assert.match(app,/await startActorSpeech\(meta,cached\.blob,startAt,true\)/);
  assert.match(app,/function startReceivedSpeech\(event\)/);
  const replay=app.slice(app.indexOf('async function replayActorSpeech'),app.indexOf('function handleActorSpeechSignal'));
  assert.match(replay,/api\/kitten\/audio\//);
  assert.doesNotMatch(replay,/api\/kitten\/synthesize/);
});

test('persistent NPC creation assigns its runtime-catalogue voice immediately when available',async()=>{
  const app=await readFile(new URL('../assets/app.js',import.meta.url),'utf8');
  assert.match(app,/voiceProfile:kittenVoices\.length\?assignVoice\(kittenVoices/);
  assert.match(app,/for\(const entity of state\.entities\).*assignVoice\(kittenVoices/s);
  assert.match(app,/data-entity-voice-choice/);
});

test('settings separate default Kitten character acting from optional narration engines',async()=>{
  const [app,html]=await Promise.all([readFile(new URL('../assets/app.js',import.meta.url),'utf8'),readFile(new URL('../dnd_localfirst_demo.html',import.meta.url),'utf8')]);
  assert.match(html,/Character voices/);
  assert.match(html,/Named character dialogue uses each character’s assigned KittenTTS 2 voice by default/);
  assert.match(html,/Narration engine<select id="voiceMode"/);
  assert.match(html,/KittenTTS 2 · host-local · recommended/);
  assert.match(html,/Off · character dialogue still speaks/);
  assert.match(html,/Kokoro fallback settings and diagnostics/);
  assert.match(app,/requested='kitten2'/);
  assert.match(app,/performanceSpeech/);
  assert.match(app,/Named characters keep their assigned KittenTTS 2 voices/);
  assert.match(app,/audio:\{mode:'kitten2'/);
  assert.match(app,/storedCampaign\?\.audio\?\.mode==='kokoro'/);
  assert.match(app,/speakKittenNarrator\(text,epoch/);
  assert.match(app,/KittenTTS failed; trying Kokoro narrator/);
  assert.match(html,/id="kittenNarratorVoice"/);
});

test('Kitten narrator uses the stable preset while character performances remain expressive',async()=>{
  const app=await readFile(new URL('../assets/app.js',import.meta.url),'utf8');
  const worker=await readFile(new URL('../assets/kitten_worker.py',import.meta.url),'utf8');
  assert.match(app,/const preset='stable'/);
  assert.match(app,/energy:message\.speech\.energy,preset:'expressive'/);
  assert.match(worker,/options\["preset"\]\s*=\s*preset/);
  assert.match(worker,/preset not in \{"stable", "expressive"\}/);
});

test('Kitten narration speed adjusts playback scheduling and word-follow timing together',async()=>{
  const [app,html,worker]=await Promise.all([readFile(new URL('../assets/app.js',import.meta.url),'utf8'),readFile(new URL('../dnd_localfirst_demo.html',import.meta.url),'utf8'),readFile(new URL('../assets/kitten_worker.py',import.meta.url),'utf8')]);
  assert.match(html,/id="kittenNarrationRate" type="range" min="1" max="1\.5"/);
  assert.match(app,/src\.playbackRate\.value=playbackRate/);
  assert.match(app,/const playDuration=buffer\.duration\/playbackRate/);
  assert.match(app,/duration=playDuration\*1000/);
  assert.match(worker,/model\.generate\("Ready when you are\."/);
});

test('DM stream errors and incomplete completions are surfaced instead of silently discarded',async()=>{
  const [app,bridge]=await Promise.all([readFile(new URL('../assets/app.js',import.meta.url),'utf8'),readFile(new URL('../dnd_chatgpt_server.py',import.meta.url),'utf8')]);
  assert.match(app,/if\(event==='error'\)\{const error=Error\(payload\.message\|\|'The DM response failed'\);error\.failureKind=Number\.isInteger\(payload\.status\)\?/);
  assert.match(app,/if\(!completed\)\{const error=Error\('The DM response stream ended before completion/);
  assert.match(app,/The DM completed without returning narration/);
  assert.match(app,/Lantern could not get a complete DM response/);
  assert.match(app,/faro\.api\.pushLog\(\['dm_response_failed provider='/);
  assert.match(bridge,/if final_text and not streamed_text:/);
});
