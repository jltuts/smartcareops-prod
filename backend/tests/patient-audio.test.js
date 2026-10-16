import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationAudio, encodePcm } from '../../src/pages/patient/audio.js';

function mockContext(t) {
  const prior = globalThis.AudioContext;
  class Context {
    constructor(options) { this.sampleRate = options.sampleRate; this.destination = {}; this.currentTime = 0; this.state = 'running'; this.created = []; }
    createBuffer(channels, length, rate) {
      const data = new Float32Array(length);
      return { channels, sampleRate: rate, duration: length / rate, getChannelData: () => data };
    }
    createBufferSource() {
      const node = { connect(target) { this.target = target; }, disconnect() { this.disconnected = true; },
        start(at) { this.startedAt = at; }, stop() { this.stopped = true; } };
      this.created.push(node); return node;
    }
    close() { this.state = 'closed'; }
  }
  globalThis.AudioContext = Context;
  t.after(() => { globalThis.AudioContext = prior; });
}

test('PCM playback preserves signed samples, 24 kHz output, ordered chunks and drain notification', t => {
  mockContext(t);
  let drained = 0;
  const audio = new ConversationAudio(() => drained++);
  assert.equal(audio.context.sampleRate, 16000);
  const bytes = Buffer.alloc(4); bytes.writeInt16LE(32767, 0); bytes.writeInt16LE(-32768, 2);
  audio.play(bytes.toString('base64')); audio.play(bytes.toString('base64'));
  const [first, second] = audio.context.created;
  assert.equal(first.target, audio.context.destination);
  assert.equal(first.buffer.sampleRate, 24000);
  assert.deepEqual([...first.buffer.getChannelData(0)], [32767 / 32768, -1]);
  assert.equal(first.startedAt, 0.025);
  assert.equal(second.startedAt, first.startedAt + first.buffer.duration);
  first.onended(); assert.equal(drained, 0); assert.equal(audio.sources.size, 1);
  second.onended(); assert.equal(drained, 1); assert.equal(audio.sources.size, 0);
  audio.close(); assert.equal(audio.context.state, 'closed');
});

test('interruption clears queued playback without invoking completion and rejects malformed PCM', t => {
  mockContext(t);
  let drained = 0;
  const audio = new ConversationAudio(() => drained++);
  assert.throws(() => audio.play(''), /Invalid audio response/);
  assert.throws(() => audio.play(Buffer.from([1]).toString('base64')), /Invalid audio response/);
  audio.play(Buffer.alloc(4).toString('base64'));
  const [source] = audio.context.created;
  audio.interrupt();
  assert.equal(source.stopped, true); assert.equal(source.disconnected, true);
  assert.equal(source.onended, null); assert.equal(audio.sources.size, 0);
  assert.equal(audio.nextStart, 0); assert.equal(drained, 0);
  audio.close();
});

test('microphone PCM encoding clamps signed samples without changing the input array', () => {
  const input = [-2, -1, 0, 1, 2];
  const encoded = Buffer.from(encodePcm(input), 'base64');
  assert.deepEqual(Array.from({ length: 5 }, (_, i) => encoded.readInt16LE(i * 2)), [-32768, -32768, 0, 32767, 32767]);
  assert.deepEqual(input, [-2, -1, 0, 1, 2]);
});
