export function encodePcm(samples) {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(index * 2, clamped < 0 ? clamped * 32768 : clamped * 32767, true);
  });
  return btoa(String.fromCharCode(...bytes));
}

export class ConversationAudio {
  constructor(onDrained) {
    this.context = new AudioContext({ sampleRate: 16000 });
    this.sources = new Set();
    this.nextStart = 0;
    this.onDrained = onDrained;
  }
  async prepareDuplex() {
    if (navigator.audioSession && 'type' in navigator.audioSession) navigator.audioSession.type = 'play-and-record';
    if (this.context.state !== 'running') await this.context.resume();
    if (this.context.state !== 'running') throw new Error('Audio playback is unavailable');
  }
  async capture(stream, onSamples) {
    await this.context.audioWorklet.addModule('/audio-worklet-processor.js');
    if (this.context.state === 'closed') return;
    this.input = this.context.createMediaStreamSource(stream);
    this.worklet = new AudioWorkletNode(this.context, 'smartcareops-microphone');
    this.worklet.port.onmessage = event => onSamples(event.data, this.context.sampleRate);
    this.input.connect(this.worklet);
    // The worklet writes no output, so this keeps processing active without microphone feedback.
    this.worklet.connect(this.context.destination);
  }
  play(base64) {
    const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
    if (!bytes.length || bytes.length % 2) throw new Error('Invalid audio response');
    const buffer = this.context.createBuffer(1, bytes.length / 2, 24000);
    const view = new DataView(bytes.buffer);
    const output = buffer.getChannelData(0);
    for (let index = 0; index < output.length; index++) output[index] = view.getInt16(index * 2, true) / 32768;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    this.sources.add(source);
    source.onended = () => {
      source.disconnect();
      this.sources.delete(source);
      if (!this.sources.size) this.onDrained();
    };
    const start = Math.max(this.context.currentTime + .025, this.nextStart);
    if (start - this.context.currentTime > 60) throw new Error('Audio playback fell behind');
    source.start(start);
    this.nextStart = start + buffer.duration;
  }
  interrupt() {
    for (const source of this.sources) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
    this.sources.clear();
    this.nextStart = 0;
  }
  close() {
    this.interrupt();
    this.input?.disconnect();
    if (this.worklet) { this.worklet.port.onmessage = null; this.worklet.disconnect(); this.worklet.port.close(); }
    if (this.context.state !== 'closed') void this.context.close();
    if (navigator.audioSession && 'type' in navigator.audioSession) {
      try { navigator.audioSession.type = 'auto'; } catch {}
    }
  }
}
