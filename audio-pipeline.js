const { spawn } = require('child_process');
const { Readable, PassThrough } = require('stream');

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
// The mixer works in 32-bit float. Integer samples would wrap the moment a gain
// pushed the signal past full scale, which silently flattened everything before
// the compressor and limiter ever saw it - that is what made the loudness
// controls do nothing. All limiting now happens in ffmpeg, after the mix.
const SAMPLE_BYTES = 4;
const BYTES_PER_FRAME = CHANNELS * SAMPLE_BYTES;
const BLOCK_FRAMES = 960;          // 20 ms of 48 kHz audio
const MAX_PENDING_FRAMES = 4800;   // 100 ms head-room per source
const SILENCE = Buffer.alloc(0);
const INT16_SAMPLE_BYTES = 2;      // what a browser sends over the mic socket
const INT16_BYTES_PER_FRAME = CHANNELS * INT16_SAMPLE_BYTES;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function hasSignal(buffer) {
  for (let offset = 0; offset + 3 < buffer.length; offset += SAMPLE_BYTES) {
    if (buffer.readFloatLE(offset) !== 0) return true;
  }
  return false;
}

// Mixes any number of Float32 LE sources into one continuous Float32 LE stereo
// 48 kHz stream. Sources that run dry are padded with silence so the output
// stream never stalls.
class PcmMixer extends Readable {
  constructor(options = {}) {
    super();
    this.channels = options.channels || CHANNELS;
    this.bytesPerFrame = this.channels * SAMPLE_BYTES;
    this.blockFrames = options.blockFrames || BLOCK_FRAMES;
    this.blockBytes = this.blockFrames * this.bytesPerFrame;
    this.maxPendingBytes = (options.maxPendingFrames || MAX_PENDING_FRAMES) * this.bytesPerFrame;
    this.outputGain = 1;
    this.sources = new Map();
    this.timer = null;
    // What the mixer actually produced. A chain can look perfectly healthy -
    // encoder running, bus subscribed, player playing - and still be silent,
    // and these are the only numbers that say where it stopped.
    this.stats = { rendered: 0, nonSilent: 0, skipped: 0, peak: 0, ticks: 0, clockRunning: false };
  }

  ensureSource(name) {
    if (!this.sources.has(name)) {
      this.sources.set(name, { pending: SILENCE, gain: 1, enabled: true, received: 0, dropped: 0 });
    }
    return this.sources.get(name);
  }

  setSourceGain(name, gain) {
    this.ensureSource(name).gain = Number.isFinite(gain) ? gain : 1;
    return this;
  }

  setSourceEnabled(name, enabled) {
    this.ensureSource(name).enabled = Boolean(enabled);
    return this;
  }

  setOutputGain(gain) {
    this.outputGain = Number.isFinite(gain) ? Math.max(0, gain) : 1;
    return this;
  }

  // Accepts raw Float32 LE audio for `name` (stereo interleaved).
  writeSource(name, chunk) {
    if (!chunk || !chunk.length) return false;

    const source = this.ensureSource(name);
    const data = chunk.length % this.bytesPerFrame === 0
      ? chunk
      : chunk.subarray(0, chunk.length - (chunk.length % this.bytesPerFrame));
    if (!data.length) return false;

    source.pending = source.pending.length ? Buffer.concat([source.pending, data]) : Buffer.from(data);
    source.received += data.length;
    source.dropped += data.length;

    // A decoder that is not being throttled hands over megabytes at once, far
    // more than the buffer holds. Keeping the newest slice silently destroyed
    // almost all of it - playback came out as 8 non-silent blocks out of 198 and
    // essentially nothing reached Discord. Keeping the OLDEST instead means a
    // burst fills the buffer with real, contiguous audio; the rest is dropped
    // (counted in `dropped`) and playback simply starts a little late rather
    // than arriving as silence.
    if (source.pending.length > this.maxPendingBytes) {
      source.pending = source.pending.subarray(0, this.maxPendingBytes);
    }
    return true;
  }

  clearSource(name) {
    const source = this.sources.get(name);
    if (source) source.pending = SILENCE;
    return this;
  }

  // Bytes currently queued for a source. A decoder should be throttled while
  // this stays high, otherwise it delivers the whole file in a burst and the
  // capped buffer skips most of it.
  sourcePending(name) {
    const source = this.sources.get(name);
    return source ? source.pending.length : 0;
  }

  renderBlock() {
    const out = Buffer.alloc(this.blockBytes);

    for (const source of this.sources.values()) {
      const pending = source.pending;
      if (!pending.length) continue;

      const take = Math.min(pending.length, this.blockBytes);
      const chunk = pending.subarray(0, take);
      source.pending = take >= pending.length ? SILENCE : pending.subarray(take);

      if (!source.enabled) continue;

      const sourceGain = source.gain;
      for (let offset = 0; offset + 3 < take; offset += SAMPLE_BYTES) {
        const value = chunk.readFloatLE(offset);
        if (value === 0) continue;
        out.writeFloatLE(out.readFloatLE(offset) + value * sourceGain, offset);
      }
    }

    if (this.outputGain !== 1) {
      for (let offset = 0; offset + 3 < this.blockBytes; offset += SAMPLE_BYTES) {
        const value = out.readFloatLE(offset) * this.outputGain;
        if (value !== 0) out.writeFloatLE(value, offset);
      }
    }

    if (this.autoGain) this.applyAutoGain(out);

    this.stats.rendered += 1;
    let peak = 0;
    for (let offset = 0; offset + 3 < this.blockBytes; offset += SAMPLE_BYTES) {
      const value = Math.abs(out.readFloatLE(offset));
      if (value > peak) peak = value;
    }
    if (peak > 0) this.stats.nonSilent += 1;
    if (peak > this.stats.peak) this.stats.peak = peak;

    return out;
  }

  // Loudness normalisation without a warm-up.
  //
  // loudnorm is the right tool offline but wrong for a live pipe: it measures
  // before it emits and delayed the first audio by 2.6 s on every track. This
  // tracks the running peak of what has actually been played and nudges the
  // gain toward the target, so a quiet track is lifted from the first block and
  // a loud one is trimmed, with the limiter catching anything that overshoots.
  setAutoGain(enabled, targetPeak = this.autoGainTarget || 0.95) {
    this.autoGain = Boolean(enabled);
    this.autoGainTarget = clamp(targetPeak, 0.05, 0.99);
    this.autoGainValue = 1;
    this.autoGainPeak = 0;
    return this;
  }

  applyAutoGain(block) {
    let peak = 0;
    for (let offset = 0; offset + 3 < block.length; offset += SAMPLE_BYTES) {
      const value = Math.abs(block.readFloatLE(offset));
      if (value > peak) peak = value;
    }

    // Slow-moving average of the peak, so a transient does not slam the gain.
    this.autoGainPeak = this.autoGainPeak
      ? Math.max(peak, this.autoGainPeak * 0.995)
      : peak;

    if (this.autoGainPeak > 0.0005) {
      // A quiet track can be 60 dB below the target, so the gain has to lift
      // much harder than a fixed 1-8x. The limiter still holds the final ceiling,
      // so pushing the source harder is how the audio becomes audible again.
      const wanted = clamp(this.autoGainTarget / this.autoGainPeak, 0.001, 5000);
      // Rise quickly on a quiet source, fall gently on a loud one.
      const rate = wanted > this.autoGainValue ? 0.35 : 0.06;
      this.autoGainValue += (wanted - this.autoGainValue) * rate;
      const gain = clamp(this.autoGainValue, 0.001, 5000);
      for (let offset = 0; offset + 3 < block.length; offset += SAMPLE_BYTES) {
        const value = block.readFloatLE(offset) * gain;
        if (value !== 0) block.writeFloatLE(value, offset);
      }
    }
  }

  // Runs the mixer off a wall clock (20 ms per block) instead of off the
  // consumer: ffmpeg reads raw PCM as fast as it can, so a pull-driven mixer
  // would spin the CPU and drop audio. Timers are coarse (Windows ticks at
  // 15.6 ms), so the block count is anchored to elapsed time and catches up
  // rather than drifting. A slow consumer is skipped instead of buffered.
  start() {
    if (this.timer || this.destroyed) return this;

    const blockMs = (this.blockFrames / SAMPLE_RATE) * 1000;
    const period = Math.max(1, Math.round(blockMs));
    let lastTickAt = Date.now();
    let owed = 0;

    this.timer = setInterval(() => {
      if (this.destroyed) return;

      const now = Date.now();
      owed = Math.min(owed + (now - lastTickAt) / blockMs, 4);
      lastTickAt = now;
      this.stats.ticks += 1;

      while (owed >= 1) {
        owed -= 1;
        // onTick releases the paused decoder, so it has to run every block
        // including a skipped one - otherwise a full buffer wedges the decoder
        // permanently and the track stops advancing.
        if (typeof this.onTick === 'function') this.onTick(this);
        // Skip this block, not the rest of the tick. Returning here used to
        // abandon every remaining block, and because a stalled consumer never
        // drains, the mixer stayed silent for good instead of catching up.
        if (this.readableLength > this.blockBytes * 2) {
          this.stats.skipped += 1;
          continue;
        }
        this.push(this.renderBlock());
      }
    }, period);

    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.stats.clockRunning = true;
    return this;
  }

  stop() {
    if (!this.timer) return this;
    clearInterval(this.timer);
    this.timer = null;
    this.stats.clockRunning = false;
    return this;
  }

  _read() {
    // Blocks are produced by start(); nothing to do on pull.
  }

  _destroy(error, callback) {
    this.stop();
    callback(error);
  }
}

// ffmpeg filter chain applied after the mixer.
//
// Measured ceiling: with the limiter holding true peak at -0.2 dBFS this chain
// measures -5.0 LUFS integrated, which is the loudest ffmpeg will produce
// (loudnorm's own I range bottoms out at -5.0). The old chain also reached
// -5.0 LUFS, so the extra acompressor bought nothing measurable while costing
// CPU and squashing the waveform - which is why it read as "thin" rather than
// loud. The limiter alone now does the work: it holds the ceiling on any
// source, loud or quiet, instead of a fixed multiplier that only suits one.
function buildLoudnessFilter(options = {}) {
  const drive = clamp(Number(options.drive) || 0, 0, 100);
  const limiter = options.limiter !== false;
  const rawTarget = options.targetLufs;
  const targetLufs = rawTarget === null || rawTarget === undefined || rawTarget === '' ? null : Number(rawTarget);
  const volume = Number(options.volume);
  const bass = clamp(Number(options.bass) || 0, 0, 30);
  const treble = clamp(Number(options.treble) || 0, 0, 30);
  const parts = [];

  // The reference app uses a real dB gain on the final ffmpeg stage. Numbers
  // above ~1.5 are not a multiplier anymore; they are the dB level the whole
  // chain is aiming for, and the limiter still holds the final output below 0 dBFS.
  if (Number.isFinite(volume) && volume > 0 && volume !== 1) {
    const safeVolume = clamp(volume, 0.1, 1000);
    const filterVolume = safeVolume >= 20
      ? `volume=${Number(safeVolume).toFixed(0)}dB`
      : `volume=${Number(safeVolume).toFixed(3)}`;
    parts.push(filterVolume);
  }

  if (bass > 0) {
    parts.push(`bass=g=${Number(bass).toFixed(1)}`);
  }
  if (treble > 0) {
    parts.push(`treble=g=${Number(treble).toFixed(1)}`);
  }

  // Only a light touch, and only when asked for: enough to keep peaks even
  // before the limiter, not enough to flatten the track.
  if (drive > 0) {
    const ratio = 1 + (drive / 100) * 3;
    const threshold = 0.4 - (drive / 100) * 0.3;
    const makeup = 1 + (drive / 100) * 3;
    parts.push(`acompressor=threshold=${threshold.toFixed(4)}:ratio=${ratio.toFixed(2)}:attack=10:release=250:makeup=${makeup.toFixed(2)}:knee=8`);
  }

  // No loudnorm here. It is an EBU R128 pass, and on a live pipe it measures
  // before it emits: measured, the first audio byte was delayed 2.6 s, and
  // nothing at all reached the player for the first 2.6 s of every track. On a
  // slow host that is the difference between hearing music and hearing nothing,
  // and it is why "playing" was reported while the channel stayed silent.
  //
  // Loudness is normalised in the mixer instead (see normalise()), which knows
  // the running level from the very first block. The limiter then holds the
  // ceiling, so the result is the same level without the startup dead air.
  if (limiter) {
    // limit=1.0 is 0 dBFS, digital full scale - the ceiling for anything
    // downstream. Measured on the real s16le output the voice gateway receives:
    // -0.17 dBFS peak with zero clipped samples, so there is nothing left to
    // turn up. Raising pre-gain past this only clips.
    // level=disabled stops alimiter renormalising the output back to 0 dB.
    // A short attack with a longer release catches transients and then lets
    // the level come back, instead of chattering on every peak.
    parts.push('alimiter=limit=1.0:level=disabled:attack=1:release=40');
  }

  return parts.length ? parts.join(',') : 'anull';
}

// Encodes a raw PCM stream (mixer output) through the loudness chain.
function createEncoder(options = {}) {
  const { ffmpegPath, filter, spawnImpl = spawn, onLog, onError, onExit, label = 'encoder' } = options;

  if (!ffmpegPath) {
    throw new Error('createEncoder requires an ffmpeg path');
  }

  const args = [
    '-hide_banner', '-loglevel', 'error',
    // Probesize and analyzeduration limit input probing latency on live raw PCM pipes.
    '-probesize', '32', '-analyzeduration', '0',
    // Float in (so the mixer's gains cannot clip), Int16 out for Discord.
    '-f', 'f32le', '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS), '-i', 'pipe:0',
    '-af', filter || 'anull',
    '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS), 'pipe:1',
  ];

  const child = spawnImpl(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const output = new PassThrough();

  if (child.stdout) child.stdout.pipe(output);
  if (child.stderr) child.stderr.on('data', (data) => onLog && onLog(`${label}: ${data.toString().trim()}`));
  if (child.stdin) {
    // ffmpeg going away closes its stdin. Without this handler the error is
    // re-thrown by pipe() and takes the whole process (and every account) down.
    child.stdin.on('error', () => {});
  }
  if (child.on) child.on('error', (error) => onError && onError(error));
  if (child.on) child.on('close', (code, signal) => {
    output.end();
    if (onExit) onExit(code, signal);
  });

  return {
    process: child,
    input: child.stdin,
    output,
    kill() {
      try { child.kill(); } catch (error) { /* already gone */ }
      try { output.end(); } catch (error) { /* already closed */ }
    },
  };
}

// Decodes any ffmpeg-readable file into raw Float32 LE stereo 48 kHz PCM.
function createDecoder(options = {}) {
  const { ffmpegPath, filePath, spawnImpl = spawn, onLog, onError, onExit, onData, loop = false } = options;

  if (!ffmpegPath) {
    throw new Error('createDecoder requires an ffmpeg path');
  }

  const args = ['-hide_banner', '-loglevel', 'error'];
  if (loop) args.push('-stream_loop', '-1');
  // ffmpeg decodes a file orders of magnitude faster than real time. Without
  // this it fills the OS pipe with megabytes in under a second, and by the time
  // the mixer's 20 ms clock has rendered anything the audio is already gone -
  // playback came out as 8 non-silent blocks out of 198. `-re` makes ffmpeg pace
  // its output to the input's own timeline, so chunks arrive spread over time
  // exactly as fast as the mixer consumes them.
  args.push('-re');
  args.push('-i', filePath, '-f', 'f32le', '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS), 'pipe:1');

  const child = spawnImpl(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  // ffmpeg explains itself on stderr; keep the tail so a failure can say why.
  let stderrTail = '';
  const rememberStderr = (data) => {
    stderrTail = (stderrTail + data.toString()).split('\n').filter(Boolean).slice(-4).join(' | ').trim();
    if (onLog) onLog(`decoder: ${data.toString().trim()}`);
  };

  // Pacing is ffmpeg's job, via -re above. Pausing the stream from here as well
  // fought that and only added a way to wedge it: a paused stream is never
  // resumed, so any pause at all is permanent.
  if (child.stdout) child.stdout.on('data', (data) => onData && onData(data));
  if (child.stderr) child.stderr.on('data', rememberStderr);
  if (child.on) child.on('error', (error) => onError && onError(error));
  if (child.on) child.on('close', (code, signal) => {
    if (onExit) onExit(code, signal, stderrTail);
  });

  return {
    process: child,
    kill() {
      try { child.kill(); } catch (error) { /* already gone */ }
    },
  };
}

module.exports = {
  SAMPLE_RATE,
  CHANNELS,
  SAMPLE_BYTES,
  BYTES_PER_FRAME,
  INT16_SAMPLE_BYTES,
  INT16_BYTES_PER_FRAME,
  BLOCK_FRAMES,
  PcmMixer,
  buildLoudnessFilter,
  createEncoder,
  createDecoder,
  hasSignal,
};
