const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const { PcmMixer, buildLoudnessFilter, createEncoder, BLOCK_FRAMES, BYTES_PER_FRAME } = require('../audio-pipeline');

// Float32 LE samples: the format the mixer works in.
function pcm(values) {
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  return buffer;
}

function sampleAt(buffer, index) {
  return buffer.readFloatLE(index * 4);
}

test('PcmMixer emits fixed 20 ms blocks and sums sources', () => {
  const mixer = new PcmMixer();
  assert.equal(mixer.blockBytes, BLOCK_FRAMES * BYTES_PER_FRAME);

  mixer.writeSource('music', pcm(new Array(BLOCK_FRAMES * 2).fill(0.5)));
  mixer.writeSource('mic', pcm(new Array(BLOCK_FRAMES * 2).fill(0.25)));

  const block = mixer.renderBlock();
  assert.equal(block.length, BLOCK_FRAMES * BYTES_PER_FRAME);
  assert.equal(sampleAt(block, 0), 0.75);
  assert.equal(sampleAt(block, 1), 0.75, 'both channels of the frame are summed');
});

test('PcmMixer pads with silence when a source runs dry', () => {
  const mixer = new PcmMixer({ blockFrames: 2 });
  // Two blocks worth of audio: 2 frames * 2 channels * 2 samples.
  mixer.writeSource('music', pcm([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]));

  assert.equal(sampleAt(mixer.renderBlock(), 0), 0.5);
  assert.equal(sampleAt(mixer.renderBlock(), 0), 0.5);
  const silent = mixer.renderBlock();
  assert.equal(sampleAt(silent, 0), 0, 'no signal, no stall');
  assert.equal(silent.length, 2 * BYTES_PER_FRAME);
});

test('PcmMixer gains in float, so big boosts never wrap', () => {
  const boosted = new PcmMixer({ blockFrames: 2 });
  boosted.setSourceGain('music', 12);
  boosted.writeSource('music', pcm([0.5, 0.5, 0.5, 0.5]));
  assert.equal(sampleAt(boosted.renderBlock(), 0), 6, '12x of 0.5 stays 6, not clipped');

  const hot = new PcmMixer({ blockFrames: 2 });
  hot.setSourceGain('a', 30);
  hot.setSourceGain('b', 30);
  hot.writeSource('a', pcm([0.9, 0.9, 0.9, 0.9]));
  hot.writeSource('b', pcm([0.9, 0.9, 0.9, 0.9]));
  const summed = sampleAt(hot.renderBlock(), 0);
  assert.equal(summed, 54, 'two loud sources add up instead of wrapping negative');
  assert.ok(summed > 1, 'ffmpeg sees the true level and does the limiting');

  const disabled = new PcmMixer({ blockFrames: 2 });
  disabled.setSourceEnabled('music', false);
  disabled.writeSource('music', pcm([0.5, 0.5, 0.5, 0.5]));
  assert.equal(sampleAt(disabled.renderBlock(), 0), 0);
});

test('PcmMixer caps the per-source buffer so a fast decoder cannot grow memory', () => {
  const mixer = new PcmMixer({ blockFrames: 1, maxPendingFrames: 4 });
  mixer.writeSource('music', pcm(new Array(64).fill(0.5)));
  assert.ok(mixer.sources.get('music').pending.length <= 4 * BYTES_PER_FRAME);
});

test('PcmMixer clocks itself and never buffers faster than real time', async () => {
  const mixer = new PcmMixer({ blockFrames: 960 });
  assert.equal(mixer.timer, null);

  mixer.start();
  assert.ok(mixer.timer, 'start() arms the wall clock');

  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(mixer.readableLength > 0, 'blocks are produced without a consumer');
  assert.ok(
    mixer.readableLength <= mixer.blockBytes * 3,
    `slow consumer must not grow the buffer (${mixer.readableLength} bytes)`,
  );

  mixer.stop();
  const frozen = mixer.readableLength;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(mixer.readableLength, frozen, 'stop() halts the clock');

  mixer.destroy();
});

test('PcmMixer keeps producing blocks when its consumer stalls', async () => {
  // The stall guard used to be `if (readableLength > blockBytes * 2) return`,
  // which returned from the whole interval callback. One slow tick therefore
  // skipped every later block in that tick, and since a stalled consumer never
  // drains, the mixer went permanently quiet - audio stopped entirely rather
  // than skipping. It has to break out of the loop only.
  const mixer = new PcmMixer({ blockFrames: 960 });
  mixer.start();

  // Simulate a stalled consumer by never reading: fill the readable buffer.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const stalled = mixer.readableLength;
  assert.ok(stalled > 0, 'blocks are produced without a consumer');
  assert.ok(
    stalled <= mixer.blockBytes * 3,
    `a stalled consumer must not grow the buffer without bound (${stalled} bytes)`,
  );

  // A stalled consumer must be skipped, not left to grow the buffer - and the
  // clock must keep ticking (counted in `skipped`) rather than going dead.
  const skippedWhileStalled = mixer.stats.skipped;
  assert.ok(skippedWhileStalled > 0, 'a stalled consumer is counted as skipped');

  // Draining lets it produce real audio again rather than staying stuck. The
  // buffer has to be actually consumed, not just peeked at.
  const renderedBefore = mixer.stats.rendered;
  mixer.writeSource('music', pcm(new Array(960 * 2).fill(0.5)));
  const drain = setInterval(() => {
    while (mixer.read() !== null) { /* consume, like ffmpeg would */ }
  }, 10);
  await new Promise((resolve) => setTimeout(resolve, 250));
  clearInterval(drain);

  assert.ok(
    mixer.stats.rendered > renderedBefore,
    'the clock keeps running and recovers once the consumer drains',
  );
  assert.ok(mixer.stats.nonSilent > 0, 'and it is producing audible blocks again');

  mixer.stop();
  mixer.destroy();
});

test('PcmMixer reports what it rendered so a silent chain can be diagnosed', () => {
  const mixer = new PcmMixer({ blockFrames: 4 });
  mixer.renderBlock();
  assert.equal(mixer.stats.rendered, 1, 'every block is counted');

  mixer.setSourceGain('music', 0);
  mixer.writeSource('music', pcm([0.5, 0.5, 0.5, 0.5]));
  const silent = mixer.renderBlock();
  assert.equal(mixer.stats.rendered, 2);
  assert.equal(mixer.stats.nonSilent, 0, 'a zero-gain source counts as silence');
  assert.ok(silent.every((byte) => byte === 0));
});

test('buildLoudnessFilter adds compression and limiting', () => {
  assert.equal(buildLoudnessFilter({ drive: 0, limiter: false }), 'anull');

  const boosted = buildLoudnessFilter({ volume: 1.5, drive: 40, limiter: true });
  assert.match(boosted, /^volume=/);
  assert.match(boosted, /volume=1\.500/);
  assert.match(boosted, /^volume=1\.500,acompressor=/);
  assert.match(boosted, /acompressor=/);
  // Leave headroom below 0 dBFS for the gateway's Int16/Opus conversion.
  assert.match(boosted, /alimiter=limit=0\.95/);
  const masterBoost = buildLoudnessFilter({ volume: 8, masterGain: 4, limiter: true });
  assert.match(masterBoost, /volume=8\.000,volume=4\.0,alimiter=/, 'master gain follows normalization and stays before the limiter');
  assert.match(boosted, /level=disabled/, 'the limit has to be respected, not auto-normalised');

  // loudnorm must not come back. It is an EBU R128 pass that measures before
  // it emits, which delayed the first audio of every track by 2.6 s on a live
  // pipe. Loudness is normalised in the mixer instead (PcmMixer.setAutoGain).
  assert.doesNotMatch(boosted, /loudnorm/, 'loudnorm delays the start of playback');
  assert.doesNotMatch(buildLoudnessFilter({ targetLufs: -9 }), /loudnorm/);
});

test('PcmMixer normalises loudness without any warm-up delay', () => {
  // The property that matters: a quiet source is lifted from the very first
  // block, so there is no dead air at the start of a track.
  const peakOf = (mixer) => {
    mixer.writeSource('music', pcm(new Array(4 * 2).fill(0.001)));
    const out = mixer.renderBlock();
    let peak = 0;
    for (let i = 0; i < out.length; i += 4) peak = Math.max(peak, Math.abs(out.readFloatLE(i)));
    return peak;
  };

  const mixer = new PcmMixer({ blockFrames: 4 });
  mixer.setAutoGain(true, 0.89);
  const first = peakOf(mixer);

  assert.ok(first > 0.001, 'the first block must already carry amplified audio');
  for (let i = 0; i < 200; i++) peakOf(mixer);
  const settled = peakOf(mixer);
  assert.ok(settled > 0.3, `a quiet source should reach the target (peak ${settled.toFixed(3)})`);

  // A loud source must be pulled back down rather than clipped.
  const loudMixer = new PcmMixer({ blockFrames: 4 });
  loudMixer.setAutoGain(true, 0.89);
  for (let i = 0; i < 200; i++) {
    loudMixer.writeSource('music', pcm(new Array(4 * 2).fill(0.99)));
    loudMixer.renderBlock();
  }
  loudMixer.writeSource('music', pcm(new Array(4 * 2).fill(0.99)));
  const loudOut = loudMixer.renderBlock();
  let loudPeak = 0;
  for (let i = 0; i < loudOut.length; i += 4) loudPeak = Math.max(loudPeak, Math.abs(loudOut.readFloatLE(i)));
  assert.ok(loudPeak < 0.99, `a loud source should be trimmed, not passed through (${loudPeak.toFixed(3)})`);

  const extremeMixer = new PcmMixer({ blockFrames: 4 });
  extremeMixer.setSourceGain('music', 1000);
  extremeMixer.setAutoGain(true, 0.89);
  for (let i = 0; i < 300; i++) {
    extremeMixer.writeSource('music', pcm(new Array(4 * 2).fill(0.5)));
    extremeMixer.renderBlock();
  }
  extremeMixer.writeSource('music', pcm(new Array(4 * 2).fill(0.5)));
  const normalizedHot = sampleAt(extremeMixer.renderBlock(), 0);
  assert.ok(
    Math.abs(normalizedHot - 0.89) < 0.05,
    `auto-gain must attenuate extreme pre-gain instead of driving the limiter (${normalizedHot.toFixed(3)})`,
  );

  // And it must be off by default.
  const plain = new PcmMixer({ blockFrames: 4 });
  plain.writeSource('music', pcm(new Array(4 * 2).fill(0.001)));
  const untouched = plain.renderBlock();
  assert.ok(Math.abs(untouched.readFloatLE(0)) < 0.002, 'normalisation is opt-in');
});

test('reference-style dB loudness is allowed without clipping', () => {
  const boosted = buildLoudnessFilter({ volume: 60, drive: 30, bass: 30, treble: 30, limiter: true });
  assert.match(boosted, /volume=60(?:\.0+)?dB|volume=1000(?:\.0+)?/);
  assert.match(boosted, /bass=g=30/);
  assert.match(boosted, /treble=g=30/);
  assert.match(boosted, /alimiter=limit=0\.95/);
});

test('drive is a light touch, not a crusher', () => {
  // The old mapping ran 19:1 at full drive, which pinned every sample to the
  // limiter: same measured loudness, far more distortion. Keep it gentle.
  const hard = buildLoudnessFilter({ drive: 100, limiter: true });
  const ratio = Number(/ratio=([\d.]+)/.exec(hard)[1]);
  assert.ok(ratio <= 4.01, `drive 100 must stay gentle (ratio ${ratio})`);
});

test('normalisation lifts a quiet source to the same level as a loud one', () => {
  // The regression: a fixed pre-gain plus a gentle compressor cannot make a
  // quiet track loud. Once the source peak falls below the compressor
  // threshold nothing reaches the limiter, so the output level just tracks the
  // source - which is why quiet MP3s played inaudibly while loud ones were
  // fine. Normalisation in the mixer is what fixes it, and this asserts the
  // property directly.
  const settledPeak = (amp) => {
    const mixer = new PcmMixer();
    mixer.setAutoGain(true, 0.89);
    const block = Buffer.alloc(960 * 8);
    for (let offset = 0; offset < 1920; offset += 4) block.writeFloatLE(amp, offset);
    for (let i = 0; i < 400; i++) {
      mixer.writeSource('music', block);
      mixer.renderBlock();
    }
    mixer.writeSource('music', block);
    const out = mixer.renderBlock();
    let peak = 0;
    for (let offset = 0; offset + 3 < out.length; offset += 4) {
      peak = Math.max(peak, Math.abs(out.readFloatLE(offset)));
    }
    return peak;
  };

  const hot = settledPeak(0.5);
  const quiet = settledPeak(0.01);
  const veryQuiet = settledPeak(0.001);

  assert.ok(quiet > 0.3, `a quiet source must be lifted (peak ${quiet.toFixed(3)})`);
  assert.ok(veryQuiet > 0.3, `a very quiet source must be lifted (peak ${veryQuiet.toFixed(3)})`);

  // The whole point: the output must not depend on how quiet the input was.
  const spread = Math.max(hot, quiet, veryQuiet) - Math.min(hot, quiet, veryQuiet);
  assert.ok(spread < 0.35, `output level must not depend on the source (spread ${spread.toFixed(3)})`);
});

test('the audio the gateway receives is at digital full scale', () => {
  // Measured on the real s16le output rather than the float level before
  // encoding. This is the number that decides whether the bot is loud, and it
  // is why asking for more gain cannot help: 0 dBFS is the ceiling.
  const { spawnSync } = require('node:child_process');
  const ffmpeg = require('ffmpeg-static');
  const fs = require('node:fs');
  if (!ffmpeg || !fs.existsSync(ffmpeg)) return;  // no ffmpeg here

  const os = require('node:os');
  const path = require('node:path');
  const { PcmMixer } = require('../audio-pipeline');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ceiling-'));
  const run = (args) => spawnSync(ffmpeg, ['-hide_banner', '-nostdin', ...args], { encoding: 'utf8' });

  const src = path.join(work, 'm.wav');
  run(['-y', '-f', 'lavfi', '-i',
    "aevalsrc='0.3*sin(2*PI*220*t)*(0.6+0.4*sin(2*PI*1.3*t))+0.2*sin(2*PI*330*t)':d=8:s=48000",
    '-ac', '2', src]);

  // Push the source through the mixer exactly as the server does, so the
  // normalisation the chain relies on is part of what is measured. Written as a
  // real wav so ffmpeg can read it back.
  const normalised = path.join(work, 'n.wav');
  const decoded = run(['-y', '-i', src, '-f', 'f32le', '-ar', '48000', '-ac', '2',
    path.join(work, 'f32.raw')]);
  assert.equal(decoded.status, 0, 'source decodes');
  const raw = fs.readFileSync(path.join(work, 'f32.raw'));
  const chunks = [];
  const mixer = new PcmMixer();
  mixer.setAutoGain(true, 0.89);
  for (let offset = 0; offset + 7680 <= raw.length; offset += 7680) {
    mixer.writeSource('music', raw.subarray(offset, offset + 7680));
    chunks.push(Buffer.from(mixer.renderBlock()));
  }
  const frames = chunks.length * 960;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + frames * 8, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(48000, 24);
  header.writeUInt32LE(48000 * 8, 28);
  header.writeUInt16LE(8, 32);
  header.writeUInt16LE(32, 34);
  header.write('data', 36);
  header.writeUInt32LE(frames * 8, 40);
  fs.writeFileSync(normalised, Buffer.concat([header, ...chunks]));

  const delivered = (file, filter) => {
    const pcm = path.join(work, 'o.raw');
    const enc = run(['-y', '-i', file, '-af', filter, '-f', 's16le', '-ar', '48000', '-ac', '2', pcm]);
    if (enc.status !== 0) return null;
    const buf = fs.readFileSync(pcm);
    let peak = 0;
    let clipped = 0;
    let squareSum = 0;
    const n = buf.length / 2;
    for (let i = 0; i < n; i++) {
      const sample = buf.readInt16LE(i * 2);
      const a = Math.abs(sample);
      squareSum += sample * sample;
      if (a > peak) peak = a;
      if (a >= 32767) clipped += 1;
    }
    return { peak, clipped, samples: n, rms: Math.sqrt(squareSum / n) };
  };

  const base = buildLoudnessFilter({ volume: 12, drive: 0, limiter: true, targetLufs: -5 });
  const normal = delivered(normalised, base);
  const louder = delivered(normalised, buildLoudnessFilter({ volume: 12, drive: 0, masterGain: 100, limiter: true, targetLufs: -5 }));
  const compressed = delivered(normalised, buildLoudnessFilter({ volume: 12, drive: 20, limiter: true, targetLufs: -5 }));
  // Asking for 1000x, as "make it louder" usually means.
  const extreme = delivered(normalised, `volume=1000,${base}`);

  fs.rmSync(work, { recursive: true, force: true });

  assert.ok(normal, 'the encoder produced output');
  assert.ok(louder, 'the post-normalization gain chain produced output');
  assert.ok(compressed, 'the optional compressor chain produced output');
  assert.ok(louder.rms > normal.rms, 'post-normalization gain must raise average delivered level');
  assert.ok(louder.rms > normal.rms * 1.1, 'maximum output gain must raise average delivered loudness materially');
  assert.ok(louder.peak <= 32768, 'the limiter must prevent the output gain from exceeding full scale');
  assert.ok(louder.clipped / louder.samples < 0.001, 'maximum output gain must keep PCM clipping negligible');
  assert.ok(
    normal.rms > compressed.rms,
    `limiter-only default should deliver more average level than compression (${normal.rms.toFixed(0)} vs ${compressed.rms.toFixed(0)})`,
  );
  // The mixer normalises to a 0.89 peak ceiling rather than driving to 0 dBFS.
  // That is deliberate: 0 dBFS is where Opus starts audibly crackling, and the
  // last fraction of a dB is not worth the distortion. It is still about -1 dBFS
  // and as loud as this should go.
  const peakDb = 20 * Math.log10(normal.peak / 32768);
  assert.ok(peakDb >= -3 && peakDb <= 0, `output should sit at or just under full scale (${peakDb.toFixed(1)} dBFS)`);
  // A handful of full-scale samples out of a track is inaudible through Opus;
  // a large clipped run would not be.
  const clipRatio = normal.clipped / normal.samples;
  assert.ok(clipRatio < 0.001, `clipping must stay negligible (${normal.clipped} samples)`);

  // More gain past the limiter cannot produce anything louder than full scale.
  // It can only distort: the compressor saturates and the limiter holds the
  // ceiling, so 1000x buys distortion, not volume.
  assert.ok(extreme, 'the 1000x chain produced output');
  assert.ok(extreme.peak <= 32768, 'nothing can exceed 0 dBFS');
  const extremeDb = 20 * Math.log10(extreme.peak / 32768);
  assert.ok(extremeDb < 0.5, `1000x must not push past full scale (${extremeDb.toFixed(1)} dBFS)`);
  const extremeClip = extreme.clipped / extreme.samples;
  assert.ok(
    extremeClip >= clipRatio,
    `and it only adds clipping, not loudness (${(extremeClip * 100).toFixed(3)}% vs ${(clipRatio * 100).toFixed(3)}%)`,
  );
});

test('real audio survives the decoder into the encoder', async () => {
  // The regression this pins: ffmpeg decodes a track orders of magnitude faster
  // than real time. When it did that, one giant chunk arrived, the capped source
  // buffer threw most of it away, and playback came out as 8 non-silent blocks
  // out of 198 - essentially silence, with every status line claiming success.
  // Uses the real ffmpeg and the real decoder/mixer, because the unit tests stub
  // ffmpeg and cannot see this class of failure.
  const { spawn } = require('node:child_process');
  const { PassThrough } = require('node:stream');
  const ffmpeg = require('ffmpeg-static');
  const fs = require('node:fs');
  if (!ffmpeg || !fs.existsSync(ffmpeg)) return;  // no ffmpeg here

  const os = require('node:os');
  const path = require('node:path');
  const { PcmMixer, buildLoudnessFilter, createDecoder } = require('../audio-pipeline');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'live-'));
  const run = (args) => require('node:child_process')
    .spawnSync(ffmpeg, ['-hide_banner', '-nostdin', ...args], { encoding: 'utf8' });

  const mp3 = path.join(work, 't.mp3');
  run(['-y', '-f', 'lavfi', '-i',
    "aevalsrc='0.25*sin(2*PI*220*t)':d=20:s=48000", '-ac', '2', '-b:a', '192k', mp3]);

  const mixer = new PcmMixer();
  mixer.start();

  const encoder = spawn(ffmpeg, [
    '-hide_banner', '-loglevel', 'error',
    '-probesize', '32', '-analyzeduration', '0',
    '-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0',
    '-af', buildLoudnessFilter({ volume: 12, drive: 20, limiter: true, targetLufs: -5 }),
    '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  const sink = new PassThrough();
  let encodedBytes = 0;
  sink.on('data', (c) => { encodedBytes += c.length; });
  encoder.stdout.pipe(sink);
  mixer.pipe(encoder.stdin);
  encoder.stdin.on('error', () => {});

  let chunks = 0;
  const decoder = createDecoder({
    ffmpegPath: ffmpeg,
    filePath: mp3,
    onData: (chunk) => { chunks += 1; mixer.writeSource('music', chunk); },
  });

  await new Promise((resolve) => setTimeout(resolve, 3000));
  // Give the encoder time to flush. loudnorm is an EBU R128 pass and buffers
  // while it measures, so a moment after the last block it still has output to
  // emit; killing it immediately would report zero bytes.
  await new Promise((resolve) => setTimeout(resolve, 800));
  const emitted = encodedBytes;
  decoder.kill();
  encoder.kill();
  await new Promise((resolve) => setTimeout(resolve, 100));
  fs.rmSync(work, { recursive: true, force: true });

  assert.ok(chunks > 5, `the decoder must deliver many small chunks, not one burst (${chunks})`);
  assert.ok(mixer.stats.rendered > 100, `the mixer must be rendering (${mixer.stats.rendered})`);
  const withAudio = mixer.stats.nonSilent / Math.max(1, mixer.stats.rendered);
  assert.ok(withAudio > 0.9, `nearly every rendered block must carry audio (${(withAudio * 100).toFixed(0)}%)`);
  assert.ok(emitted > 0, 'the encoder must actually emit audio for Discord');
});

test('createEncoder pipes raw PCM through the injected ffmpeg', async () => {
  const spawned = [];
  const spawnImpl = (command, args) => {
    spawned.push({ command, args });
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    child.stdin.pipe(child.stdout);
    return child;
  };

  const encoder = createEncoder({ ffmpegPath: 'fake-ffmpeg', filter: 'alimiter', spawnImpl });
  encoder.input.write(pcm([0.5, -0.5, 1, 0.25]));

  const output = await new Promise((resolve) => encoder.output.once('data', resolve));
  assert.equal(output.length, 16, 'four float samples came through unchanged');

  const { args } = spawned[0];
  assert.ok(args.includes('pipe:0'));
  assert.ok(args.includes('pipe:1'));
  assert.equal(args[args.indexOf('-af') + 1], 'alimiter');
  assert.equal(args[args.indexOf('-ar') + 1], '48000');
  assert.equal(args[args.indexOf('-ac') + 1], '2');
  assert.equal(args[args.indexOf('-f') + 1], 'f32le', 'float in, so mixer gains cannot clip');
  assert.ok(args.includes('s16le'), 'Int16 out for Discord');
});
