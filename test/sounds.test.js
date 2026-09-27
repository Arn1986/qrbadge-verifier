import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const script = readFileSync(new URL('../public/sounds.js', import.meta.url), 'utf8');
test('approval and denial are distinct; unknown verification outcomes stay silent', () => {
  const played = [];
  const checkbox = { checked: true };
  class AudioContext {
    state = 'suspended';
    currentTime = 1;
    destination = {};
    resume() { this.state = 'running'; return Promise.resolve(); }
    createOscillator() {
      const note = { frequency: null, type: '' };
      return {
        frequency: { setValueAtTime(value) { note.frequency = value; } },
        connect(destination) { return destination; },
        start() { played.push(note); }, stop() {}, disconnect() {}
      };
    }
    createGain() {
      return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} };
    }
  }
  const window = { AudioContext };
  runInNewContext(script, { window, document: { querySelector: () => checkbox } });
  window.BadgeSounds.unlock();
  window.BadgeSounds.play('valid');
  assert.deepEqual(played.map(note => note.frequency), [740, 990]);
  played.length = 0;
  for (const status of ['not_yet_valid', 'expired', 'cannot_verify', 'malformed', 'unsupported']) {
    window.BadgeSounds.play(status);
    assert.deepEqual(played.map(note => note.frequency), [360, 260]);
    played.length = 0;
  }
  for (const status of ['connection_error', 'rate_limited', 'service_error']) window.BadgeSounds.play(status);
  assert.equal(played.length, 0);
  checkbox.checked = false;
  window.BadgeSounds.play('valid');
  assert.equal(played.length, 0);
});
