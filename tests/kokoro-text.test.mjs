import test from 'node:test';
import assert from 'node:assert/strict';
import { splitKokoroText } from '../assets/kokoro-text.mjs';

test('nearby sentences share a generation request to reduce between-sentence gaps', () => {
  const text = 'The door swings wide. Dust pours into the hall. Somewhere below, chains rattle.';
  assert.deepEqual(splitKokoroText(text), [text]);
});

test('long narration is split into bounded passages while preserving all words', () => {
  const text = Array.from({ length: 36 }, (_, i) => `Sentence number ${i + 1} ends here.`).join(' ');
  const chunks = splitKokoroText(text, 120);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.length <= 120));
  assert.equal(chunks.join(' '), text);
});

test('a single long sentence is split without dropping punctuation or words', () => {
  const text = `${'heavy '.repeat(40)}impact!`;
  const chunks = splitKokoroText(text, 80);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(' '), text.trim());
  assert.match(chunks.at(-1), /impact!$/);
});

test('empty and whitespace-only text return no synthesis work', () => {
  assert.deepEqual(splitKokoroText(''), []);
  assert.deepEqual(splitKokoroText('   '), []);
});
