require('dotenv').config();

const { Client } = require('discord.js-selfbot-v13');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, NoSubscriberBehavior, StreamType, VoiceConnectionStatus, entersState } = require('@discordjs/voice');
const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('ffmpeg-static');
const { PcmMixer, buildLoudnessFilter, createEncoder, createDecoder, INT16_SAMPLE_BYTES, INT16_BYTES_PER_FRAME } = require('./audio-pipeline');
const { readTokenFile, writeTokenFile, diffTokenLists, mergeTokenFile } = require('./token-store');
const { renderHomePage } = require('./views/home');
const { renderMicRoutePage } = require('./views/mic-route');
const { renderTokenFilePage } = require('./views/token-file');

const MIC_WORKLET_SOURCE = `class VeeraPcmTap extends AudioWorkletProcessor {
  constructor(options) {
    super();
    var opts = options.processorOptions || {};
    this.blockFrames = opts.blockFrames || 960;
    this.buffer = new Float32Array(this.blockFrames);
    this.offset = 0;
  }
  process(inputs) {
    var input = inputs[0];
    var channel = input && input[0];
    if (!channel) return true;
    for (var i = 0; i < channel.length; i++) {
      this.buffer[this.offset++] = channel[i];
      if (this.offset === this.blockFrames) {
        var pcm = new Int16Array(this.blockFrames);
        for (var j = 0; j < this.blockFrames; j++) {
          var sample = this.buffer[j] < -1 ? -1 : (this.buffer[j] > 1 ? 1 : this.buffer[j]);
          pcm[j] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        }
        this.port.postMessage({ type: 'pcm', buffer: pcm.buffer }, [pcm.buffer]);
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('veera-pcm-tap', VeeraPcmTap);
`;

function parseList(value) {
  return (value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseJSONBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => data += chunk);
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function ffmpegCommandUsable(candidate) {
  if (!candidate) return false;
  if (candidate === 'ffmpeg') {
    try {
      const { spawnSync } = require('child_process');
      const result = spawnSync(candidate, ['-version'], { stdio: 'ignore' });
      return !result.error && result.status === 0;
    } catch (error) {
      return false;
    }
  }
  return fs.existsSync(candidate);
}

function resolveFfmpegPath(explicitPath) {
  const candidates = [];
  const value = typeof explicitPath === 'string' ? explicitPath.trim() : '';
  if (value) candidates.push(value);

  try {
    const bundled = require('ffmpeg-static');
    if (bundled) candidates.push(bundled);
  } catch (error) {
    // Ignore: the host may only have a system ffmpeg binary.
  }

  candidates.push('ffmpeg');

  for (const candidate of candidates) {
    if (ffmpegCommandUsable(candidate)) return candidate;
  }

  return value || 'ffmpeg';
}

const autoJoin = (process.env.AUTO_JOIN || 'false').toLowerCase() === 'true';
const channelIds = parseList(process.env.VOICE_CHANNEL_IDS || process.env.VOICE_CHANNEL_ID || process.env.CHANNEL_ID || '');
const rawMaxBots = Number(process.env.MAX_BOTS || process.env.MAX_BOT_COUNT || 0);
const maxBots = Number.isFinite(rawMaxBots) && rawMaxBots > 0 ? Math.floor(rawMaxBots) : Number.MAX_SAFE_INTEGER;
const host = process.env.HOST || process.env.HOSTNAME || '0.0.0.0';
const port = Number(process.env.PORT || 3000);
const keepAliveMs = Number(process.env.KEEPALIVE_MS || 15000);
const ffmpegPath = resolveFfmpegPath(process.env.FFMPEG_PATH || ffmpeg);
const sharedAudioPath = path.resolve(process.cwd(), process.env.AUDIO_FILE || './shared_audio.mp3');
const tokenFilePath = path.resolve(process.cwd(), process.env.TOKENS_FILE || 'tokens.txt');
const tokenFileEnv = process.env.BOT_TOKENS || process.env.BOT_TOKEN || '';
// Optional gate for the endpoints that can read or write the raw token file.
const tokenFileKey = (process.env.TOKEN_FILE_KEY || '').trim();

// ffmpeg-static downloads its binary during npm install. If a host installs with
// --ignore-scripts, or blocks the download, the bundled copy may not exist on
// disk. Prefer a real system binary when available so playback still works on
// Render/Debian hosts and the dashboard does not report a silent dead end.
const ffmpegAvailable = ffmpegCommandUsable(ffmpegPath);

const loudness = {
  // Mixer-side source gain feeds the automatic peak normalizer below.
  volume: clampNumber(process.env.AUDIO_VOLUME, 0.5, 1000, 1000),
  // Applied after normalization, immediately before the output limiter.
  outputGain: clampNumber(process.env.AUDIO_OUTPUT_GAIN, 1, 100, 100),
  // Off by default: the limiter-only path uses more of the available headroom.
  drive: clampNumber(process.env.AUDIO_DRIVE, 0, 100, 0),
  bass: clampNumber(process.env.AUDIO_BASS, 0, 30, 0),
  treble: clampNumber(process.env.AUDIO_TREBLE, 0, 30, 0),
  limiter: (process.env.AUDIO_LIMITER || 'true').toLowerCase() !== 'false',
  // This is the setting that actually makes playback loud. Measured, a fixed
  // pre-gain cannot: once the source peak drops below the compressor threshold
  // nothing pushes it into the limiter, and the output stays as quiet as the
  // source. loudnorm measures the incoming audio and scales it to a target, so
  // every track comes out at the same level.
  //
  //   no loudnorm, quiet source: -34 LUFS   (inaudible)
  //   target -9,  quiet source:  -9 LUFS
  //   target -5,  any source:   -5 LUFS     (loudest ffmpeg allows)
  //
  // Default is -5 because the goal is the loudest possible output. Set
  // AUDIO_TARGET_LUFS=-9 for a slightly tamer result.
  targetLufs: process.env.AUDIO_TARGET_LUFS === undefined
    ? -5
    : clampNumber(process.env.AUDIO_TARGET_LUFS, -31, -5, -5),
  duckMusic: (process.env.AUDIO_DUCK_MUSIC || 'true').toLowerCase() !== 'false',
  // 0.8 rather than 0.35: the old default cut the music by 9 dB the whole time
  // the mic page was open. Ducking should be noticeable over speech without
  // making the music disappear.
  duckLevel: clampNumber(process.env.AUDIO_DUCK_LEVEL, 0, 1, 0.8),
  micGain: clampNumber(process.env.MIC_GAIN, 0.1, 100, 6),
};

const routing = {
  default: ['mix', 'music', 'mic', 'off'].includes(process.env.MIC_ROUTE_DEFAULT) ? process.env.MIC_ROUTE_DEFAULT : 'mix',
  bots: {},
};

const micState = { clients: new Set(), packets: 0, lastPacketAt: null, channels: 1, level: 0 };
const tokenSync = { lastSyncAt: null, lastTrigger: 'startup', added: 0, removed: 0 };
let tokens = [];

// --- TOKEN FILE IS THE ONLY SOURCE OF TRUTH -------------------------------
function seedTokenFile() {
  if (readTokenFile(tokenFilePath).length > 0 || !tokenFileEnv.trim()) return;

  try {
    writeTokenFile(tokenFilePath, tokenFileEnv);
    console.log(`📝 Seeded ${tokenFilePath} from BOT_TOKENS/BOT_TOKEN (one-time migration).`);
  } catch (error) {
    console.warn(`⚠️ Could not write ${tokenFilePath}: ${error.message}`);
  }
}

function syncTokensFromFile(trigger = 'manual') {
  const fileTokens = readTokenFile(tokenFilePath);
  const { added, removed } = diffTokenLists(tokens, fileTokens);
  tokens = fileTokens;

  for (const token of removed) {
    const index = bots.findIndex((bot) => bot.token === token);
    if (index === -1) continue;
    const [bot] = bots.splice(index, 1);
    console.log(`🗑️ [${trigger}] Token ${maskToken(token)} removed from ${path.basename(tokenFilePath)}; logging out.`);
    bot.shutdown();
  }

  for (const token of added) {
    if (bots.some((bot) => bot.token === token)) continue;
    if (bots.length >= maxBots) {
      console.warn(`⚠️ MAX_BOTS (${maxBots}) reached; extra tokens in ${path.basename(tokenFilePath)} are ignored.`);
      break;
    }
    const bot = createBot(token, bots.length);
    bots.push(bot);
    console.log(`➕ [${trigger}] Token ${maskToken(token)} added from ${path.basename(tokenFilePath)}.`);
    loginBot(bot, bots.length - 1);
  }

  tokenSync.lastSyncAt = new Date().toISOString();
  tokenSync.lastTrigger = trigger;
  tokenSync.added = added.length;
  tokenSync.removed = removed.length;

  if (added.length === 0 && removed.length === 0) {
    console.log(`👀 [${trigger}] No token file changes (${tokens.length} token(s)).`);
  }

  return { added: added.length, removed: removed.length, count: tokens.length };
}

function maskToken(token) {
  const value = String(token || '');
  if (value.length <= 12) return '***';
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function tokenFileAllowed(req) {
  if (!tokenFileKey) return true;
  const provided = req.headers['x-token-key'];
  return typeof provided === 'string' && provided === tokenFileKey;
}

function describeTokenFile() {
  return {
    path: tokenFilePath,
    exists: fs.existsSync(tokenFilePath),
    count: tokens.length,
    lastSyncAt: tokenSync.lastSyncAt,
    lastTrigger: tokenSync.lastTrigger,
    added: tokenSync.added,
    removed: tokenSync.removed,
    protected: Boolean(tokenFileKey),
  };
}

function watchTokenFile() {
  fs.watchFile(tokenFilePath, { interval: 2000 }, (current, previous) => {
    if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) return;
    clearTimeout(watchTokenFile.timer);
    watchTokenFile.timer = setTimeout(() => {
      console.log(`📄 ${path.basename(tokenFilePath)} changed on disk.`);
      syncTokensFromFile('file-watch');
    }, 400);
  });
}

// --- AUDIO BUSES ----------------------------------------------------------
// Every bus is a live PCM mixer -> ffmpeg loudness chain -> audio player.
// Sources that run dry are padded with silence, so a bus never stalls.
// The mixers hold a few hundred ms of source so a fast decoder never has to
// drop audio, and the decoder is throttled against that (see pushMusicChunk).
// 28800 frames at 48 kHz = 600 ms, i.e. a 230 kB buffer per source.
const MUSIC_SOURCE_FRAMES = 28800;
const buses = {
  mix: { mixer: new PcmMixer({ maxPendingFrames: MUSIC_SOURCE_FRAMES }), player: null, encoder: null, resource: null, retryTimer: null, broken: false },
  music: { mixer: new PcmMixer({ maxPendingFrames: MUSIC_SOURCE_FRAMES }), player: null, encoder: null, resource: null, retryTimer: null, broken: false },
  mic: { mixer: new PcmMixer(), player: null, encoder: null, resource: null, retryTimer: null, broken: false },
};

// The audio clock is what lets a paused decoder run again.
buses.mix.mixer.onTick = releaseMusicPressure;
buses.music.mixer.onTick = releaseMusicPressure;

// Loudness is normalised here rather than by ffmpeg's loudnorm, which measures
// before it emits and delayed the start of every track by 2.6 s. The music buses
// lift a quiet track to the ceiling from the first block; the mic bus is left
// alone so speech dynamics survive.
function applyAutoGain() {
  const on = loudness.targetLufs !== null;
  // -5 LUFS lands around a 0.95 peak ceiling, which is the loudest useful
  // output that still survives Opus and the client's own volume ramp.
  const target = loudness.targetLufs === null
    ? 0.95
    : 0.95 * (10 ** ((clampNumber(loudness.targetLufs, -31, -5, -5) + 5) / 20));
  for (const name of ['mix', 'music']) {
    buses[name].mixer.setAutoGain(on, clampNumber(target, 0.05, 0.99, 0.89));
  }
}

// How many accounts currently have a connection subscribed to this bus. A bus
// with audio flowing and nobody subscribed is the one combination that is
// genuinely silent, and it is invisible in the logs.
//
// connection.state.subscription is a PlayerSubscription, not the player itself,
// so compare against its .player.
function busesSubscribed(name) {
  const player = buses[name].player;
  if (!player) return 0;
  let count = 0;
  for (const bot of bots) {
    const connection = bot.getConnection();
    if (!connection) continue;
    if (connection.state?.subscription?.player === player) count += 1;
  }
  return count;
}

// Whether any account is routed to this bus, or is about to be. Used to avoid
// starting an ffmpeg process for a bus nobody listens to.
function routesInUse(name) {
  return bots.some((bot, index) => routeForBot(index) === name);
}

function currentFilter() {
  // The fixed preamp establishes the baseline; user outputGain is applied after
  // normalization and before the limiter, so it changes the delivered level.
  // Never forward mixer gain here: AUDIO_VOLUME=1000 would mean 1000 dB.
  return buildLoudnessFilter({ ...loudness, volume: 8, masterGain: loudness.outputGain });
}

function stopBus(name) {
  const bus = buses[name];
  if (!bus) return;

  bus.mixer.unpipe();
  bus.mixer.stop();
  if (bus.encoder) {
    bus.encoder.kill();
    bus.encoder = null;
  }
  if (bus.player) {
    try { bus.player.stop(true); } catch (error) { /* already stopped */ }
  }
  bus.resource = null;
}

// An AudioPlayer gives up after this many consecutive 20 ms frames with nothing
// to read, and the default is 5 - a hundred milliseconds. ffmpeg easily takes
// longer than that to emit its first chunk on a loaded host, and the player
// never comes back on its own: once idle it stops draining its stream, so
// ffmpeg blocks writing stdout and stops reading the mixer, the mixer's
// readable buffer fills, every block is skipped, and the bus is silent for good.
// The mixer already pads with silence, so a stall only means silence - there is
// nothing to gain from tearing the player down, so allow a long stall instead.
const PLAYER_MAX_MISSED_FRAMES = 250;   // 5 s at 20 ms a frame

function startBus(name) {
  const bus = buses[name];
  if (!bus) return false;

  // Already running and actually playing: nothing to do.
  if (bus.encoder && bus.player && bus.player.state?.status !== 'idle') return false;

  // An idle player is holding a stream that will now never be drained again,
  // which is what wedges ffmpeg and starves the mixer. Drop the whole chain so
  // the restart below is clean - otherwise `if (bus.encoder) return` meant a
  // dead bus could never be revived and only a process restart brought sound
  // back.
  if (bus.encoder) {
    console.log(`♻️ [${name}] Player had stopped; rebuilding the bus.`);
    stopBus(name);
  }

  try {
    if (!bus.player) {
      bus.player = createAudioPlayer({
        behaviors: {
          noSubscriber: NoSubscriberBehavior.Play,
          maxMissedFrames: PLAYER_MAX_MISSED_FRAMES,
        },
      });
      bus.player.on('error', (error) => console.error(`❌ Bus ${name} player error:`, error.message));
    }

    // The handlers ignore a stale encoder, so an intentional restart (kill on
    // stopBus) never looks like a crash and never triggers the retry loop.
    const encoder = createEncoder({
      ffmpegPath,
      filter: currentFilter(),
      label: `bus ${name}`,
      onLog: (message) => message && console.error(`FFmpeg [${name}]:`, message),
      onError: (error) => {
        if (bus.encoder !== encoder) return;
        bus.encoder = null;
        bus.broken = true;
        console.error(`❌ ffmpeg encoder for bus "${name}" failed: ${error.message}`);
        scheduleBusRetry(name);
      },
      onExit: (code) => {
        if (bus.encoder !== encoder) return;
        bus.encoder = null;
        bus.broken = true;
        console.error(`⚠️ ffmpeg encoder for bus "${name}" exited with code ${code}.`);
        scheduleBusRetry(name);
      },
    });

    bus.encoder = encoder;
    bus.mixer.start();
    bus.mixer.pipe(encoder.input);
    bus.resource = createAudioResource(encoder.output, {
      inputType: StreamType.Raw,
      inlineVolume: false,
    });
    bus.player.play(bus.resource);
    bus.broken = false;
    console.log(`🔊 Bus "${name}" running (${currentFilter()}).`);
    return true;
  } catch (error) {
    bus.broken = true;
    console.error(`❌ Could not start bus "${name}":`, error.message);
    scheduleBusRetry(name);
    return false;
  }
}

function scheduleBusRetry(name) {
  const bus = buses[name];
  if (!bus || bus.retryTimer) return;
  bus.retryTimer = setTimeout(() => {
    bus.retryTimer = null;
    if (!bus.broken) return;
    console.log(`🔁 Retrying bus "${name}"...`);
    startBus(name);
  }, 15000);
}

function applyLoudnessFilter() {
  for (const name of Object.keys(buses)) {
    if (!buses[name].encoder) continue;
    stopBus(name);
    startBus(name);
  }
  applyRouting();
}

function isMicActive() {
  // The hold keeps the music ducked through the gaps between words, so it does
  // not pump up and down mid-sentence.
  return Boolean(micState.lastPacketAt) && Date.now() - micState.lastPacketAt < MIC_DUCK_HOLD_MS;
}

// The pre-gain actually applied to music right now. refreshGains() and the
// dashboard both read this, so the number on the page cannot drift from what
// the mixer is really doing.
function currentMusicGain() {
  const ducked = isMicActive() && loudness.duckMusic;
  return clampNumber(loudness.volume * (ducked ? loudness.duckLevel : 1), 0.5, 1000, 1000);
}

function refreshGains() {
  buses.mix.mixer.setSourceGain('music', currentMusicGain());
  buses.music.mixer.setSourceGain('music', currentMusicGain());
  buses.mix.mixer.setSourceGain('mic', loudness.micGain);
  buses.mic.mixer.setSourceGain('mic', loudness.micGain);
}

// The browser sends Int16 mono; the mixer works in float stereo.
function micToStereoFloat(buffer, channels) {
  const samples = Math.floor(buffer.length / INT16_SAMPLE_BYTES);
  const alreadyStereo = channels === 2 && samples % 2 === 0;
  const out = Buffer.allocUnsafe(alreadyStereo ? samples * 4 : samples * 8);

  for (let index = 0; index < samples; index++) {
    const sample = buffer.readInt16LE(index * INT16_SAMPLE_BYTES) / 32768;
    if (alreadyStereo) {
      out.writeFloatLE(sample, index * 4);
    } else {
      out.writeFloatLE(sample, index * 8);
      out.writeFloatLE(sample, index * 8 + 4);
    }
  }
  return out;
}

// Ducking used to trigger on "a packet arrived", and the browser sends a frame
// every 20 ms whether or not anyone is talking. With the mic page open that
// meant the music sat permanently at 35% (-9.1 dB) even in silence, which is
// most of "the music is too quiet". Now it only ducks when the frame actually
// carries signal, and it holds briefly so it does not pump between words.
const MIC_SIGNAL_FLOOR = 0.004;   // ~ -48 dBFS: room noise, not speech
const MIC_DUCK_HOLD_MS = 700;

function micFrameLevel(stereo) {
  let peak = 0;
  for (let offset = 0; offset + 3 < stereo.length; offset += 4) {
    const value = Math.abs(stereo.readFloatLE(offset));
    if (value > peak) peak = value;
  }
  return peak;
}

function pushMicChunk(chunk, channels) {
  if (!chunk || !chunk.length) return;
  const stereo = micToStereoFloat(chunk, channels || 1);
  buses.mix.mixer.writeSource('mic', stereo);
  buses.mic.mixer.writeSource('mic', stereo);
  micState.packets += 1;

  const level = micFrameLevel(stereo);
  micState.level = level;
  if (level >= MIC_SIGNAL_FLOOR) {
    micState.lastPacketAt = Date.now();
  }
}

// ffmpeg decodes a file far faster than real time, so its output lands in a
// ffmpeg decodes a file far faster than real time, so it is throttled: after
// every chunk we check how far ahead the mixers are and pause the decoder until
// they catch up. This happens per chunk, not per tick - a tick is 20 ms and
// ffmpeg can push a whole track in that time, which used to mean either skipping
// the audio or buffering megabytes (and stalling the process with it).
const MUSIC_PAUSE_BYTES = 115200;  // 300 ms of 48 kHz stereo Float32
const MUSIC_RESUME_BYTES = 38400;  // 100 ms
let musicPaused = false;
let musicError = null;
// Bytes of decoded PCM ffmpeg has actually handed us this play. Zero here with a
// running bus means the decoder produced nothing at all, which is a different
// fault from the mixer or the player.
let musicDecodedBytes = 0;

// How far ahead of real time the fed mixers are.
//
// Only buses that are actually being consumed count. A mixer with no encoder
// piped to it has nothing draining its readable buffer, so its stall guard
// stops it rendering entirely and its source buffer fills and stays full -
// counting it would wedge the decoder permanently.
//
// When nothing is being consumed (play pressed before anyone joined) this
// returns 0, which is correct: there is no real-time constraint to honour yet,
// and the track stays buffered rather than being consumed in a fraction of a
// second. /audio/play starts the buses, so playback still advances normally.
function musicPending() {
  let pending = 0;
  for (const name of ['mix', 'music']) {
    const bus = buses[name];
    if (bus && bus.encoder) pending = Math.max(pending, bus.mixer.sourcePending('music'));
  }
  return pending;
}

function decoderStdout() {
  return musicDecoder && musicDecoder.process ? musicDecoder.process.stdout : null;
}

function pauseMusicDecoder() {
  const stdout = decoderStdout();
  if (musicPaused || !stdout) return;
  musicPaused = true;
  stdout.pause();
}

function resumeMusicDecoder() {
  const stdout = decoderStdout();
  if (!musicPaused || !stdout) return;
  musicPaused = false;
  stdout.resume();
}

// The mixer's clock is cheap (a JS timer doing float maths); the ffmpeg encoder
// is the expensive part. A bus that is fed but not clocked never drains its
// source buffer, so it fills and stops rendering.
function ensureMixerClock(name) {
  const bus = buses[name];
  if (bus && !bus.mixer.timer) bus.mixer.start();
  return bus;
}

function pushMusicChunk(chunk) {
  if (!chunk || !chunk.length) return;

  // No manual throttle here: the decoder is paced by ffmpeg's own -re flag and
  // by stdout backpressure, so chunks already arrive at roughly real time.
  // Pausing on top of that only fought it and dropped audio.
  for (const name of ['mix', 'music']) {
    const bus = buses[name];
    if (!bus) continue;
    // Nothing is listening and nothing is encoded, so do not buffer for it.
    if (!bus.encoder && !routesInUse(name) && busesSubscribed(name) === 0) {
      bus.mixer.clearSource('music');
      continue;
    }
    ensureMixerClock(name);
    bus.mixer.writeSource('music', chunk);
  }
}

// Runs on the audio clock: release the decoder's own backpressure once the
// mixers have room again.
function releaseMusicPressure() {
  if (!musicPaused) return;
  if (musicPending() <= MUSIC_RESUME_BYTES) resumeMusicDecoder();
}

let musicDecoder = null;

// Decodes half a second to check ffmpeg can actually read the file, and
// returns a human-readable reason when it cannot.
function probeAudio(filePath) {
  return new Promise((resolve) => {
    if (!fs.existsSync(filePath)) {
      resolve('the file is missing');
      return;
    }

    const size = fs.statSync(filePath).size;
    if (size === 0) {
      resolve('the file is empty (0 bytes)');
      return;
    }

    let child;
    try {
      child = require('child_process').spawn(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-t', '0.5', '-i', filePath, '-f', 'null', '-',
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) {
      resolve(`ffmpeg could not start: ${error.message}`);
      return;
    }

    let reason = '';
    child.stderr.on('data', (data) => {
      reason = (reason + data.toString()).split('\n').filter(Boolean).slice(-2).join(' ').trim();
    });
    child.on('error', (error) => resolve(`ffmpeg could not start: ${error.message}`));
    child.on('close', (code) => {
      if (code === 0) {
        resolve(null);
        return;
      }
      // ffmpeg names the file in its complaint; the user does not care about our
      // temp path, only what is wrong with the audio.
      const clean = reason
        .split(filePath).join('the file')
        .split(path.basename(filePath)).join('the file')
        .replace(/\s+/g, ' ')
        .trim();

      resolve(clean || (size < 4096
        ? 'it is not audio data (too small and ffmpeg reported nothing)'
        : `ffmpeg exited with code ${code}`));
    });
  });
}

function playGlobalAudio() {
  if (!fs.existsSync(sharedAudioPath)) return false;
  stopGlobalAudio();

  // Count what this play actually decodes, and baseline the mixer stats so the
  // dashboard can report the current track rather than all-time totals.
  musicDecodedBytes = 0;
  for (const name of ['mix', 'music']) {
    const stats = buses[name].mixer.stats;
    buses[name].statsAtPlay = { rendered: stats.rendered, nonSilent: stats.nonSilent, skipped: stats.skipped, ticks: stats.ticks };
  }

  const decoder = createDecoder({
    ffmpegPath,
    filePath: sharedAudioPath,
    loop: true,
    onData: (chunk) => {
      musicDecodedBytes += chunk.length;
      pushMusicChunk(chunk);
    },
    onError: (error) => console.error('❌ ffmpeg decoder failed:', error.message),
    onExit: (code, signal, reason) => {
      // Stopping playback kills the decoder on purpose; that is not a failure.
      if (musicDecoder !== decoder) return;
      musicDecoder = null;
      if (code === 0) return;

      probeAudio(sharedAudioPath).then((problem) => {
        musicError = problem || reason || `ffmpeg exited with code ${code}${signal ? ` (${signal})` : ''}`;
        console.error(
          `❌ Could not play ${path.basename(sharedAudioPath)}: ${musicError}. `
          + 'Upload a different file - the previous upload was kept.',
        );
      });
    },
  });
  musicDecoder = decoder;

  return true;
}

function stopGlobalAudio() {
  musicError = null;
  musicPaused = false;
  buses.mix.mixer.clearSource('music');
  buses.music.mixer.clearSource('music');
  if (!musicDecoder) return;
  musicDecoder.kill();
  musicDecoder = null;
}

const ROUTE_MODES = ['mix', 'music', 'mic', 'off'];

function routeForBot(index) {
  const mode = routing.bots[index] || routing.default;
  return ROUTE_MODES.includes(mode) ? mode : 'mix';
}

function applyRouting() {
  bots.forEach((bot, index) => {
    const connection = bot.getConnection();
    if (!connection) return;

    const mode = routeForBot(index);
    if (mode === 'off') {
      try { connection.subscribe(null); } catch (error) { /* connection gone */ }
      return;
    }

    startBus(mode);
    try { connection.subscribe(buses[mode].player); } catch (error) { /* connection gone */ }
  });
}

// Accounts that are in a channel but whose Discord-side mute/deaf flags are not
// what we currently want. Only these need the expensive part of a flag change -
// a full re-join - so toggling a flag with 20-odd accounts connected does not
// churn every one of them for nothing.
function botsNeedingVoiceFlagUpdate() {
  return bots.filter((bot) => bot.channelId && bot.guildId && bot.voiceState === 'connected'
    && (bot.appliedFlags.mute !== globalMute || bot.appliedFlags.deaf !== globalDeaf));
}

// Applies the current global mute/deaf to every account that is actually
// connected. joinChannel() no-ops for the accounts Discord already agrees with,
// so this is safe to call on every flag change.
async function applyVoiceFlags() {
  const pending = botsNeedingVoiceFlagUpdate();
  for (const bot of pending) {
    await bot.joinChannel(bot.channelId, bot.guildId);
  }
  return pending.length;
}

// --- BOTS -----------------------------------------------------------------
function createBot(token, index) {
  const client = new Client({ checkUpdate: false });
  let voiceConnection = null;
  let readyPromise = null;

  const waitForReady = () => {
    if (readyPromise) return readyPromise;
    if (bot.status === 'ready' || client.readyTimestamp || client.isReady?.()) {
      return Promise.resolve();
    }
    readyPromise = new Promise((resolve, reject) => {
      const onReady = () => { cleanup(); resolve(); };
      const onError = (error) => { cleanup(); reject(error); };
      const cleanup = () => {
        client.off('ready', onReady);
        client.off('error', onError);
      };
      client.once('ready', onReady);
      client.once('error', onError);
    });
    return readyPromise;
  };

  const bot = {
    client,
    token,
    channelId: null,
    guildId: null,
    status: 'offline',
    voiceState: 'disconnected',
    lastError: null,
    // The self-mute / self-deaf Discord was last told about, not the ones we
    // merely want. joinVoiceChannel() is the only thing that sends them, and
    // @discordjs/voice hands back the existing connection without reconfiguring
    // when the same group re-joins - so a flag only reaches Discord through a
    // real re-join, and this is how we tell that one is needed.
    appliedFlags: { mute: false, deaf: false },
    getConnection() {
      return voiceConnection;
    },
    getTag() {
      return client.user ? client.user.tag : null;
    },
    async joinChannel(targetChannelId, targetGuildId) {
      if (!targetChannelId) return false;
      const flagsChanged = bot.appliedFlags.mute !== globalMute || bot.appliedFlags.deaf !== globalDeaf;
      if (voiceConnection && bot.channelId === targetChannelId && voiceConnection.state?.status === 'ready') {
        // Already in the right channel. That is only "nothing to do" when Discord
        // also already has the flags we want: selfMute/selfDeaf travel with
        // joinVoiceChannel(), and re-joining a live connection returns the existing
        // one without reconfiguring it. Returning here therefore left Mute All,
        // Unmute All, Deafen All and Undeafen All as pure no-ops - the buttons
        // reported success while Discord kept the old flags, and an account left
        // muted by an earlier click stays muted, which Discord renders as silence.
        if (!flagsChanged) {
          console.log(`ℹ️ [Bot ${index + 1}] Already in channel ${targetChannelId}`);
          bot.voiceState = 'connected';
          applyRoutingFor(bot, index, voiceConnection);
          return true;
        }
        console.log(
          `🔄 [Bot ${index + 1}] Rejoining ${targetChannelId} to apply `
          + `${globalMute ? 'self-mute' : 'self-unmute'} / ${globalDeaf ? 'self-deaf' : 'self-undeaf'}`,
        );
      }

      if (voiceConnection) {
        try { voiceConnection.destroy(); } catch (error) { /* already gone */ }
        voiceConnection = null;
      }

      bot.voiceState = 'connecting';
      bot.lastError = null;
      bot.channelId = null;
      bot.guildId = null;

      try {
        await waitForReady();

        // A 403 here means the account is not in that server (or cannot see the
        // channel), which is a very different problem from a wrong channel id.
        let fetchError = null;
        const channel = await client.channels.fetch(targetChannelId).catch((error) => {
          fetchError = error;
          return null;
        });

        if (!channel || !channel.isVoice?.()) {
          const guildCount = client.guilds?.cache?.size ?? 0;
          const code = fetchError?.code ?? fetchError?.status;
          const text = String(fetchError?.message || '');
          let message;

          if (/Missing Access|403/i.test(text) || code === 403) {
            message = `Missing Access: this account cannot see that channel. It is probably not in that `
              + `server - join it first, or pick a channel in a server it is in.`;
          } else if (/Unknown Channel|404/i.test(text) || code === 404) {
            message = `Unknown Channel: ${targetChannelId} does not exist. Copy the channel id again.`;
          } else if (channel) {
            message = `Channel ${targetChannelId} is not a voice channel.`;
          } else {
            message = `Channel ${targetChannelId} could not be read${fetchError ? `: ${text}` : ''}. `
              + `This account is in ${guildCount} server(s).`;
          }

          bot.lastError = message;
          bot.voiceState = 'failed';
          console.error(`❌ [Bot ${index + 1}] ${message}`);
          return false;
        }

        const guild = targetGuildId
          ? client.guilds.cache.get(targetGuildId) || await client.guilds.fetch(targetGuildId).catch((error) => {
            console.error(`❌ [Bot ${index + 1}] Guild fetch failed:`, error?.message || error);
            return null;
          })
          : channel.guild || await client.guilds.fetch(channel.guildId || channel.guild?.id).catch((error) => {
            console.error(`❌ [Bot ${index + 1}] Guild fetch failed:`, error?.message || error);
            return null;
          });
        if (!guild) {
          const message = `Could not resolve guild for ${channel.id}`;
          bot.lastError = message;
          bot.voiceState = 'failed';
          console.error(`❌ [Bot ${index + 1}] ${message}`);
          return false;
        }

        console.log(`✅ [Bot ${index + 1}] Joining voice channel ${channel.name} (${channel.id})`);

        let joined = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            voiceConnection = joinVoiceChannel({
              channelId: channel.id,
              guildId: guild.id,
              adapterCreator: guild.voiceAdapterCreator,
              group: client.user.id,
              selfDeaf: globalDeaf,
              selfMute: globalMute,
            });

            applyRoutingFor(bot, index, voiceConnection);

            await entersState(voiceConnection, VoiceConnectionStatus.Ready, 30000);
            joined = true;
            break;
          } catch (error) {
            const message = error?.message || String(error);
            console.error(`⚠️ [Bot ${index + 1}] Join attempt ${attempt}/3 failed: ${message}`);
            voiceConnection?.destroy();
            voiceConnection = null;
            if (attempt === 3) throw error;
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
        }

        if (!joined) {
          throw new Error('Voice join failed after retries');
        }

        bot.channelId = channel.id;
        bot.guildId = guild.id;
        bot.voiceState = 'connected';
        bot.lastError = null;
        // Remember what Discord was actually told, so the next flag change is
        // known to need a re-join instead of being swallowed as a no-op.
        bot.appliedFlags = { mute: globalMute, deaf: globalDeaf };

        voiceConnection.on('stateChange', (oldState, newState) => {
          // Discord re-emits stateChange for every heartbeat and every audio
          // update; only real transitions are worth a log line.
          if (oldState.status === newState.status) return;

          console.log(`🔌 [Bot ${index + 1}] Voice state: ${oldState.status} -> ${newState.status}`);
          if (newState.status === 'disconnected' || newState.status === 'destroyed') {
            bot.voiceState = 'disconnected';
            console.error(`❌ [Bot ${index + 1}] Voice disconnected, attempting reconnect...`);
            setTimeout(() => {
              if (bot.channelId && bot.guildId) {
                bot.joinChannel(bot.channelId, bot.guildId).catch(() => {});
              }
            }, 5000);
          }
        });

        // Progress ping: one line per account per hour, not per keepalive.
        let lastKeepAliveLog = 0;
        setInterval(() => {
          if (!voiceConnection || voiceConnection.state.status !== 'ready') return;
          if (Date.now() - lastKeepAliveLog < 3600000) return;
          lastKeepAliveLog = Date.now();
          console.log(`💚 [Bot ${index + 1}] Still connected`);
        }, keepAliveMs);
        return true;
      } catch (error) {
        const message = error?.message || String(error);
        bot.lastError = message;
        bot.voiceState = 'failed';
        console.error(`❌ [Bot ${index + 1}] Join failed: ${message}`);
        return false;
      }
    },

    leaveChannel() {
      if (voiceConnection) {
        console.log(`🟡 [Bot ${index + 1}] Leaving voice channel ${bot.channelId}`);
        voiceConnection.destroy();
        voiceConnection = null;
        bot.channelId = null;
        bot.guildId = null;
        bot.appliedFlags = { mute: false, deaf: false };
      }
    },
    shutdown() {
      try {
        if (voiceConnection) voiceConnection.destroy();
        client.destroy();
      } catch (error) { /* already gone */ }
    },
  };

  client.on('ready', async () => {
    bot.status = 'ready';
    console.log(`✅ [Bot ${index + 1}] ${client.user.tag} is ready`);

    if (!autoJoin) {
      console.log(`🟢 [Bot ${index + 1}] Staying online without auto-joining a channel`);
      return;
    }

    const targetChannelId = channelIds[index] || channelIds[0] || null;
    if (!targetChannelId) {
      console.log(`ℹ️ [Bot ${index + 1}] AUTO_JOIN enabled but no channel id was provided`);
      return;
    }

    await bot.joinChannel(targetChannelId);
  });

  client.on('error', (error) => {
    console.error(`❌ [Bot ${index + 1}] Client error:`, error);
  });

  return bot;
}

function applyRoutingFor(bot, index, connection) {
  if (!connection) return;

  const mode = routeForBot(index);
  if (mode === 'off') {
    try { connection.subscribe(null); } catch (error) { /* connection gone */ }
    return;
  }

  startBus(mode);
  try { connection.subscribe(buses[mode].player); } catch (error) { /* connection gone */ }
}

const bots = [];
let globalMute = false;
let globalDeaf = false;

async function loginBot(bot, index) {
  bot.status = 'logging_in';
  bot.lastError = null;
  console.log(`🔐 [Bot ${index + 1}] Login started`);

  try {
    await bot.client.login(bot.token);
    console.log(`🔐 [Bot ${index + 1}] Login request completed; waiting for ready event`);
    return bot;
  } catch (error) {
    bot.status = 'offline';
    bot.lastError = error?.message || String(error);
    console.error(`❌ [Bot ${index + 1}] Login failed: ${bot.lastError}`);
    return bot;
  }
}

process.on('unhandledRejection', (error) => {
  console.error('❌ Unhandled rejection:', error);
});

function shutdownAll() {
  fs.unwatchFile(tokenFilePath);
  stopGlobalAudio();
  for (const name of Object.keys(buses)) {
    stopBus(name);
    buses[name].mixer.destroy();
  }
  bots.forEach((bot) => bot.shutdown());
}

process.on('SIGTERM', () => {
  shutdownAll();
  process.exit(0);
});

process.on('SIGINT', () => {
  shutdownAll();
  process.exit(0);
});

seedTokenFile();
syncTokensFromFile('startup');
watchTokenFile();

if (tokens.length > 0) {
  // syncTokensFromFile already logged every account in.
  console.log(`🚀 ${Math.min(tokens.length, maxBots)} account(s) started from ${tokenFilePath}`);
} else {
  console.log(`🚀 Bot manager started with no accounts. Add tokens to ${tokenFilePath}.`);
}

console.log(`🧠 Loudness chain: ${currentFilter()}`);
if (ffmpegAvailable) {
  console.log(`🎚️  ffmpeg: ${ffmpegPath}`);
} else {
  console.error(`❌ ffmpeg binary not found at ${ffmpegPath}.`);
  console.error('   Nothing will play. Install it, or point FFMPEG_PATH at a working ffmpeg binary.');
}
setInterval(refreshGains, 200);
refreshGains();
applyAutoGain();

function describeSettings() {
  return {
    loudness: { ...loudness },
    tokenFile: describeTokenFile(),
    mic: {
      active: isMicActive(),
      clients: micState.clients.size,
      packets: micState.packets,
      channels: micState.channels,
      // So the page can show whether the mic is genuinely carrying signal or
      // just connected - the difference between ducking and not.
      level: micState.level,
      routing: { default: routing.default, bots: { ...routing.bots } },
    },
    audio: {
      ffmpegPath,
      ffmpegAvailable,
      filter: currentFilter(),
      playing: Boolean(musicDecoder),
      error: musicError,
      bufferedBytes: musicPending(),
      file: sharedAudioPath,
      fileExists: fs.existsSync(sharedAudioPath),
      // Discord sends nothing while an account is self-muted or self-deafened,
      // so a healthy-looking player can still be completely silent.
      mute: globalMute,
      deaf: globalDeaf,
      connected: bots.filter((bot) => bot.voiceState === 'connected').length,
      // The gain actually being applied right now, after ducking. This is the
      // number that explains "why is it quiet": the limiter sets the output
      // level, and this is how hard the source is being pushed into it.
      musicGain: currentMusicGain(),
      ducked: isMicActive() && loudness.duckMusic,
      // Per-stage counters. When nothing is audible these are the numbers that
      // say where the audio stopped: decoded bytes, then what the mixer
      // rendered, then whether the encoder produced any output.
      flow: {
        decodedBytes: musicDecodedBytes,
        playing: Boolean(musicDecoder),
        buses: Object.fromEntries(Object.entries(buses).map(([name, bus]) => [name, {
          running: Boolean(bus.encoder),
          broken: bus.broken,
          subscribed: busesSubscribed(name),
          playerState: bus.player ? bus.player.state?.status : null,
          playing: bus.player ? bus.player.state?.status === 'playing' : false,
          // These reset per play, so they describe the current track only.
          rendered: bus.mixer.stats.rendered - (bus.statsAtPlay?.rendered || 0),
          nonSilent: bus.mixer.stats.nonSilent - (bus.statsAtPlay?.nonSilent || 0),
          skipped: bus.mixer.stats.skipped - (bus.statsAtPlay?.skipped || 0),
          peak: bus.mixer.stats.peak,
          // A dead clock renders nothing at all, which looks identical to
          // "no audio" from the outside. This is the difference.
          clockRunning: bus.mixer.stats.clockRunning,
          ticks: bus.mixer.stats.ticks - (bus.statsAtPlay?.ticks || 0),
        }])),
      },
      buses: Object.fromEntries(Object.entries(buses).map(([name, bus]) => [name, { running: Boolean(bus.encoder), broken: bus.broken }])),
    },
  };
}

function botStatusPayload() {
  return bots.map((bot, index) => ({
    index: index + 1,
    ready: bot.status === 'ready',
    connected: bot.voiceState === 'connected',
    voiceState: bot.voiceState,
    channelId: bot.channelId,
    guildId: bot.guildId,
    lastError: bot.lastError,
    tag: bot.getTag(),
    route: routeForBot(index),
  }));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderHomePage());
    return;
  }

  if (url.pathname === '/mic-route' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderMicRoutePage());
    return;
  }

  if (url.pathname === '/mic-worklet.js' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
    res.end(MIC_WORKLET_SOURCE);
    return;
  }

  if (url.pathname === '/health' && req.method === 'GET') {
    sendJSON(res, 200, { status: 'ok', bots: bots.length, tokens: tokens.length });
    return;
  }

  if (url.pathname === '/settings' && req.method === 'GET') {
    sendJSON(res, 200, describeSettings());
    return;
  }

  // Voice channels an account can actually see, so nobody has to type ids.
  if (url.pathname === '/channels' && req.method === 'GET') {
    const requested = Number(url.searchParams.get('index'));
    const candidates = bots.filter((bot) => bot.status === 'ready');
    const bot = Number.isInteger(requested) && requested >= 0
      ? bots[requested]
      : candidates[0];

    if (!bot || bot.status !== 'ready') {
      sendJSON(res, 200, { guilds: [], account: null, readyAccounts: candidates.length });
      return;
    }

    try {
      const guilds = await Promise.all([...bot.client.guilds.cache.values()].map(async (guild) => {
        let channels = [...guild.channels?.cache?.values?.() || []].filter((channel) => channel.type === 2 || channel.isVoice?.());
        if (!channels.length && typeof guild.channels?.fetch === 'function') {
          try {
            const fetched = await guild.channels.fetch();
            channels = [...fetched.values()].filter((channel) => channel.type === 2 || channel.isVoice?.());
          } catch (error) { /* no permission to list them */ }
        }
        return {
          id: guild.id,
          name: guild.name,
          channels: channels.map((channel) => ({ id: channel.id, name: channel.name, bitrate: channel.bitrate })),
        };
      }));

      sendJSON(res, 200, {
        account: { index: bots.indexOf(bot) + 1, tag: bot.getTag() },
        readyAccounts: candidates.length,
        guilds: guilds.filter((guild) => guild.channels.length),
      });
    } catch (error) {
      sendJSON(res, 500, { error: error.message, guilds: [] });
    }
    return;
  }

  if (url.pathname === '/status' && req.method === 'GET') {
    const payload = botStatusPayload();
    sendJSON(res, 200, {
      bots: payload,
      joinedAll: payload.length > 0 && payload.every((bot) => bot.connected),
      loudness: { ...loudness },
      routing: { default: routing.default, bots: { ...routing.bots } },
    });
    return;
  }

  if (url.pathname === '/token-file' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderTokenFilePage());
    return;
  }

  if (url.pathname === '/api/tokens/file' && req.method === 'GET') {
    if (!tokenFileAllowed(req)) {
      sendJSON(res, 401, { error: 'Token file key required', protected: true });
      return;
    }
    const content = fs.existsSync(tokenFilePath) ? fs.readFileSync(tokenFilePath, 'utf8') : '';
    sendJSON(res, 200, { content, tokenFile: describeTokenFile() });
    return;
  }

  if (url.pathname === '/api/tokens/save' && req.method === 'POST') {
    if (!tokenFileAllowed(req)) {
      sendJSON(res, 401, { error: 'Token file key required', protected: true });
      return;
    }
    try {
      const body = await parseJSONBody(req);
      const content = typeof body.content === 'string' ? body.content : '';
      const before = readTokenFile(tokenFilePath);
      const after = writeTokenFile(tokenFilePath, content);
      const result = syncTokensFromFile('web-save');
      sendJSON(res, 200, {
        status: `Saved ${path.basename(tokenFilePath)}: ${after.length} token(s) in the file, ${result.added} account(s) logged in, ${result.removed} logged out.`,
        count: after.length,
        added: result.added,
        removed: result.removed,
      });
    } catch (error) {
      sendJSON(res, 500, { error: error.message || 'Could not save the token file' });
    }
    return;
  }

  if (url.pathname === '/api/tokens/append' && req.method === 'POST') {
    if (!tokenFileAllowed(req)) {
      sendJSON(res, 401, { error: 'Token file key required', protected: true });
      return;
    }
    try {
      const body = await parseJSONBody(req);
      const incoming = body.tokens || body.token || '';
      const merged = mergeTokenFile(tokenFilePath, incoming);
      const result = syncTokensFromFile('web-add');
      sendJSON(res, 200, {
        status: merged.added > 0
          ? `Added ${merged.added} token(s) to ${path.basename(tokenFilePath)} (${merged.count} total).`
          : `No new tokens - already in ${path.basename(tokenFilePath)} (${merged.count} total).`,
        added: merged.added,
        count: merged.count,
        loggedIn: result.added,
      });
    } catch (error) {
      sendJSON(res, 500, { error: error.message || 'Could not write the token file' });
    }
    return;
  }

  if (url.pathname === '/tokens' && req.method === 'GET') {
    const statusList = tokens.map((token, index) => {
      const bot = bots[index];
      let status = 'waiting';
      if (bot) {
        status = bot.status === 'ready' ? 'ready'
          : bot.status === 'logging_in' ? 'waiting'
          : bot.lastError && /invalid|token/i.test(bot.lastError) ? 'invalid'
          : 'offline';
      }
      return {
        index,
        masked: maskToken(token),
        status,
        lastError: bot ? bot.lastError || null : null,
        ready: bot ? bot.status === 'ready' : false,
      };
    });

    sendJSON(res, 200, {
      tokens: statusList,
      readyTokens: statusList.filter((item) => item.ready).map((item) => item.index),
      file: { path: tokenFilePath, count: tokens.length },
    });
    return;
  }

  if (url.pathname === '/tokens/reload' && req.method === 'POST') {
    const result = syncTokensFromFile('manual');
    sendJSON(res, 200, {
      status: `Reloaded ${tokenFilePath}: ${result.added} added, ${result.removed} removed, ${result.count} total.`,
      ...result,
    });
    return;
  }

  if (url.pathname === '/tokens/add' && req.method === 'POST') {
    sendJSON(res, 410, {
      error: 'Web token adding was removed. Add the token to the token file and press Reload.',
      tokenFile: tokenFilePath,
    });
    return;
  }

  if (url.pathname === '/tokens/delete' && req.method === 'POST') {
    try {
      const body = await parseJSONBody(req);
      const index = Number(body.index);
      if (!Number.isInteger(index) || index < 0 || index >= tokens.length) {
        sendJSON(res, 400, { error: 'Token index is invalid' });
        return;
      }

      const removed = tokens[index];
      tokens.splice(index, 1);
      writeTokenFile(tokenFilePath, tokens);

      const bot = bots[index];
      if (bot) {
        bot.shutdown();
        bots.splice(index, 1);
      }

      sendJSON(res, 200, {
        status: `${maskToken(removed)} removed from ${path.basename(tokenFilePath)} (${tokens.length} left).`,
        index,
        deleted: true,
      });
    } catch (error) {
      sendJSON(res, 500, { error: error.message || 'Could not delete token' });
    }
    return;
  }

  if (url.pathname === '/audio/upload' && req.method === 'POST') {
    const tempPath = `${sharedAudioPath}.upload`;
    const fileStream = fs.createWriteStream(tempPath);
    req.pipe(fileStream);

    fileStream.on('finish', () => {
      // Decode a moment of it before replacing what is already loaded: a file
      // ffmpeg cannot read would otherwise stop playback with a bare exit code.
      probeAudio(tempPath).then((problem) => {
        if (problem) {
          fs.unlink(tempPath, () => {});
          sendJSON(res, 400, { error: `That file cannot be played: ${problem}` });
          return;
        }
        try {
          fs.renameSync(tempPath, sharedAudioPath);
        } catch (error) {
          sendJSON(res, 500, { error: error.message });
          return;
        }
        musicError = null;
        sendJSON(res, 200, { status: 'uploaded', file: sharedAudioPath });
      });
    });

    fileStream.on('error', (error) => {
      sendJSON(res, 500, { error: error.message });
    });
    return;
  }

  if (url.pathname === '/audio/play' && req.method === 'POST') {
    if (!fs.existsSync(sharedAudioPath)) {
      sendJSON(res, 400, { error: 'No audio uploaded yet' });
      return;
    }
    if (!ffmpegAvailable) {
      sendJSON(res, 500, { error: `ffmpeg is missing at ${ffmpegPath}, so nothing can be played.` });
      return;
    }
    // Discord drops the audio of a self-muted or self-deafened account, so a
    // mute left over from an earlier click would make this play into silence.
    if (globalMute || globalDeaf) {
      globalMute = false;
      globalDeaf = false;
      // Only the accounts Discord still believes are muted need the re-join;
      // this used to call joinChannel() for every account, which returned early
      // as "already in channel" and so never actually unmuted anyone.
      const unmuted = await applyVoiceFlags();
      if (unmuted) console.log(`🔊 Cleared a leftover self-mute/deaf on ${unmuted} account(s) before playing.`);
    }
    if (!playGlobalAudio()) {
      sendJSON(res, 500, { error: 'Could not start playback' });
      return;
    }
    // Decode in real time up front so playback is live before anyone joins, but
    // only spin up the buses something actually listens to. Every bus is a live
    // ffmpeg process, and a 0.1-CPU host cannot afford one nobody subscribes to.
    for (const name of ['mix', 'music']) {
      if (routesInUse(name)) startBus(name);
    }
    applyRouting();

    // Playing into a bus nobody subscribes to is silent, so say who can hear it
    // instead of reporting a bare "playing".
    const connected = bots.filter((bot) => bot.voiceState === 'connected').length;
    const routed = bots.filter((bot) => routeForBot(bots.indexOf(bot)) !== 'off').length;
    const subscribed = Math.max(busesSubscribed('mix'), busesSubscribed('music'));
    let status;
    if (connected === 0) {
      status = 'Playing, but no account is in a voice channel yet - press Join Channel to be heard.';
    } else if (subscribed === 0) {
      status = `Playing, but no account is subscribed to a bus (${connected} connected). `
        + 'Check each account is not routed to "off" on the Mic Routing page.';
    } else {
      status = `Playing to ${subscribed} subscribed account(s).`;
    }

    sendJSON(res, 200, {
      status,
      filter: currentFilter(),
      connected,
      routed,
      subscribed,
      muted: globalMute,
      deaf: globalDeaf,
      audio: describeSettings().audio,
    });
    return;
  }

  if (url.pathname === '/audio/stop' && req.method === 'POST') {
    stopGlobalAudio();
    sendJSON(res, 200, { status: 'stopped' });
    return;
  }

  if ((url.pathname === '/audio/loudness' || url.pathname === '/audio/volume') && req.method === 'POST') {
    try {
      const body = await parseJSONBody(req);
      // Volume, mic gain and ducking are mixer-side and instant. Only a change
      // to the ffmpeg chain (drive / limiter / LUFS) needs the encoders rebuilt,
      // otherwise dragging a slider restarts every bus.
      const filterBefore = currentFilter();

      if (body.volume !== undefined) loudness.volume = clampNumber(body.volume, 0.5, 1000, loudness.volume);
      if (body.outputGain !== undefined) loudness.outputGain = clampNumber(body.outputGain, 1, 100, loudness.outputGain);
      if (body.micGain !== undefined) loudness.micGain = clampNumber(body.micGain, 0.1, 100, loudness.micGain);
      if (body.drive !== undefined) loudness.drive = clampNumber(body.drive, 0, 100, loudness.drive);
      if (body.bass !== undefined) loudness.bass = clampNumber(body.bass, 0, 30, loudness.bass);
      if (body.treble !== undefined) loudness.treble = clampNumber(body.treble, 0, 30, loudness.treble);
      if (body.duckLevel !== undefined) loudness.duckLevel = clampNumber(body.duckLevel, 0, 1, loudness.duckLevel);
      if (body.duckMusic !== undefined) loudness.duckMusic = Boolean(body.duckMusic);
      if (body.limiter !== undefined) loudness.limiter = Boolean(body.limiter);
      if (body.targetLufs !== undefined) {
        loudness.targetLufs = body.targetLufs === null || body.targetLufs === ''
          ? null
          : clampNumber(body.targetLufs, -31, -4, null);
      }

      refreshGains();
      applyAutoGain();
      if (currentFilter() !== filterBefore) {
        applyLoudnessFilter();
      }

      sendJSON(res, 200, { status: 'loudness updated', filter: currentFilter(), settings: describeSettings() });
    } catch (error) {
      sendJSON(res, 500, { error: error.message });
    }
    return;
  }

  if (url.pathname === '/mic/status' && req.method === 'GET') {
    sendJSON(res, 200, {
      active: isMicActive(),
      clients: micState.clients.size,
      packets: micState.packets,
      channels: micState.channels,
      level: micState.level,
      lastPacketAt: micState.lastPacketAt,
      routing: { default: routing.default, bots: { ...routing.bots } },
      loudness: { ...loudness },
    });
    return;
  }

  if (url.pathname === '/mic/routing' && req.method === 'POST') {
    try {
      const body = await parseJSONBody(req);
      if (body.default !== undefined) {
        if (!['mix', 'music', 'mic', 'off'].includes(body.default)) {
          sendJSON(res, 400, { error: 'Unknown route' });
          return;
        }
        routing.default = body.default;
      }
      if (body.bots && typeof body.bots === 'object') {
        for (const [index, mode] of Object.entries(body.bots)) {
          if (!['mix', 'music', 'mic', 'off'].includes(mode)) continue;
          routing.bots[index] = mode;
        }
      }
      applyRouting();
      sendJSON(res, 200, {
        status: 'Routing updated.',
        routing: { default: routing.default, bots: { ...routing.bots } },
      });
    } catch (error) {
      sendJSON(res, 500, { error: error.message });
    }
    return;
  }

  if (url.pathname === '/mic/stop' && req.method === 'POST') {
    const closed = micState.clients.size;
    for (const client of micState.clients) {
      try { client.close(1000, 'stopped by dashboard'); } catch (error) { /* already closed */ }
    }
    micState.clients.clear();
    micState.lastPacketAt = null;
    sendJSON(res, 200, { status: `Disconnected ${closed} mic client(s).` });
    return;
  }

  if (url.pathname.startsWith('/audio/') && ['mute', 'unmute', 'deafen', 'undeafen'].includes(url.pathname.slice(7))) {
    const action = url.pathname.slice(7);
    globalMute = action === 'mute' ? true : action === 'unmute' ? false : globalMute;
    globalDeaf = action === 'deafen' ? true : action === 'undeafen' ? false : globalDeaf;

    const labels = {
      mute: 'muted all bots',
      unmute: 'unmuted all bots',
      deafen: 'deafened all bots',
      undeafen: 'undeafened all bots',
    };

    for (const bot of botsNeedingVoiceFlagUpdate()) {
      await bot.joinChannel(bot.channelId, bot.guildId);
    }

    sendJSON(res, 200, { status: labels[action], mute: globalMute, deaf: globalDeaf });
    return;
  }

  if (url.pathname === '/stay' && req.method === 'POST') {
    for (const bot of bots) {
      if (bot.channelId && bot.guildId) {
        bot.joinChannel(bot.channelId, bot.guildId);
      }
    }
    sendJSON(res, 200, { status: 'staying in vc' });
    return;
  }

  if (url.pathname === '/join' && req.method === 'POST') {
    try {
      const body = await parseJSONBody(req);
      const targetChannelId = body.channelId || body.channel || null;
      const targetGuildId = body.guildId || body.guild || null;
      if (!targetChannelId) {
        sendJSON(res, 400, { error: 'channelId is required' });
        return;
      }

      const results = [];
      // Small batches: Discord rate-limits, and 30 accounts serially take forever.
      const batchSize = 5;
      for (let start = 0; start < bots.length; start += batchSize) {
        const batch = bots.slice(start, start + batchSize).map((bot, offset) => async () => {
          const index = start + offset;
          if (bot.status !== 'ready') {
            return {
              bot: index + 1,
              ready: false,
              connected: false,
              voiceState: bot.voiceState,
              lastError: 'Account is offline',
              success: false,
            };
          }
          const success = await bot.joinChannel(targetChannelId, targetGuildId);
          return {
            bot: index + 1,
            ready: bot.status === 'ready',
            connected: bot.voiceState === 'connected',
            voiceState: bot.voiceState,
            channelId: bot.channelId,
            guildId: bot.guildId,
            lastError: bot.lastError,
            route: routeForBot(index),
            success,
          };
        });

        results.push(...await Promise.all(batch.map((run) => run())));
      }

      const joined = results.filter((item) => item.connected).length;
      const failed = results.filter((item) => !item.connected);
      console.log(
        `📡 Join ${targetChannelId}: ${joined}/${results.length} account(s) connected` +
        (failed.length ? `, ${failed.length} failed` : ''),
      );

      sendJSON(res, 200, {
        status: `${joined}/${results.length} account(s) connected to ${targetChannelId}.` +
          (failed.length ? ` ${failed.length} could not: ${failed.slice(0, 3).map((item) => `#${item.bot}`).join(', ')}${failed.length > 3 ? '…' : ''}` : ''),
        channelId: targetChannelId,
        guildId: targetGuildId,
        joinedAll: results.length > 0 && failed.length === 0,
        connected: joined,
        total: results.length,
        results,
      });
    } catch (error) {
      sendJSON(res, 500, { error: error.message });
    }
    return;
  }

  if (url.pathname === '/leave' && req.method === 'POST') {
    for (const bot of bots) {
      bot.leaveChannel();
    }
    sendJSON(res, 200, { status: 'left' });
    return;
  }

  sendJSON(res, 404, { error: 'not found' });
});

// --- MIC WEBSOCKET --------------------------------------------------------
const wss = new WebSocketServer({ server, path: '/mic/stream', maxPayload: 512 * 1024 });

wss.on('connection', (socket) => {
  micState.clients.add(socket);
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });
  // Keep the mix bus live so mic audio is ready even before anyone joins.
  startBus('mix');
  console.log(`🎙️  Mic client connected (${micState.clients.size} total).`);

  socket.on('message', (data, isBinary) => {
    if (!isBinary) {
      try {
        const message = JSON.parse(data.toString());
        if (message.type === 'format' && (message.channels === 1 || message.channels === 2)) {
          socket.channels = message.channels;
          micState.channels = message.channels;
        }
      } catch (error) { /* ignore malformed control frames */ }
      return;
    }
    pushMicChunk(Buffer.isBuffer(data) ? data : Buffer.from(data), socket.channels);
  });

  socket.on('error', (error) => console.error('⚠️ Mic socket error:', error.message));

  socket.on('close', () => {
    micState.clients.delete(socket);
    if (micState.clients.size === 0) micState.lastPacketAt = null;
    console.log(`🎙️  Mic client disconnected (${micState.clients.size} left).`);
  });
});

const heartbeat = setInterval(() => {
  for (const client of micState.clients) {
    if (client.isAlive === false) {
      client.terminate();
      continue;
    }
    client.isAlive = false;
    try { client.ping(); } catch (error) { /* socket already gone */ }
  }
}, 30000);

server.listen(port, host, () => {
  const address = server.address();
  const livePort = address && typeof address === 'object' ? address.port : port;
  console.log(`🌐 Health server listening on ${host}:${livePort}`);
  console.log(`🧩 Dashboard: http://${host}:${livePort}/  ·  Mic routing: http://${host}:${livePort}/mic-route`);
});

setInterval(() => {
  process.stdout.write('.');
}, 60000);

module.exports = {
  server,
  bots,
  buses,
  loudness,
  routing,
  micState,
  tokenFilePath,
  // Exposed for tests: the decoder is throttled against these, and if the
  // mixer cannot buffer at least the pause threshold the decoder outruns it and
  // audio gets dropped instead of slowed down.
  MUSIC_SOURCE_FRAMES,
  MUSIC_PAUSE_BYTES,
  MUSIC_RESUME_BYTES,
  get tokens() {
    return tokens;
  },
  get musicDecoder() {
    return musicDecoder;
  },
  get musicBuffered() {
    return musicPending();
  },
  resolveFfmpegPath,
  syncTokensFromFile,
  applyRouting,
  shutdownAll,
  stopHeartbeat() {
    clearInterval(heartbeat);
  },
};
