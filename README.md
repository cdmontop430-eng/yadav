# kolaru

Render web service deployment setup for the Discord voice bot host.

- Dashboard: `/` — add tokens (one or bulk), voice control, loud audio player, bot list
- Token file: `/token-file` — add tokens, or edit `tokens.txt` directly
- Mic routing: `/mic-route` — capture the browser mic and route it per account

## Choosing a voice channel

Don't type channel ids by hand. The dashboard has a **channel picker**: pick an
account, press *Load channels*, and it lists that account's servers and voice
channels straight from Discord. *Use selected* fills the id in for you.

This matters because the two failure modes look identical from the outside but
mean opposite things:

- **`Missing Access`** (403) — the account is **not in that server**. It cannot
  join no matter how many times you retry; add the account to the server first.
- **`Unknown Channel`** (404) — the id is wrong.

With 30 accounts you will usually have a mix of both: the ones that are in the
server connect, the rest fail with the reason shown next to each account under
*Accounts*. Only accounts that actually connected will hear the music or the mic,
which is why the mic looks "not working" when most of them failed the join.

A join now runs in batches of 5 (Discord rate-limits, and 30 accounts serially
takes minutes) and logs one summary line instead of three lines per account.

## Adding tokens

Tokens live in a text file (`tokens.txt` by default, override with `TOKENS_FILE`),
one per line. Three ways to get them in, all writing the same file:

- **Dashboard → Token Manager**: paste a single token, or paste a whole list into
  the bulk box (Enter submits)
- **`/token-file` page**: add one, add a bulk list, or edit the file directly in a
  textarea and save (Ctrl+S)
- **The file itself**: write it on disk and save — the server watches it

In every case the file is the source of truth, so the dashboard, the file page and
the file on disk never disagree. Adding writes the file and logs the new accounts
in immediately; blank lines and lines starting with `#`, `;` or `//` are ignored and
duplicates are dropped. Rewriting the file from the page logs removed accounts out.

`POST /tokens/add` returns `410` on purpose: use `/api/tokens/append` (which writes
the file) instead.

**Set `TOKEN_FILE_KEY` on Render.** The file endpoints read and write real tokens, so
without a key anyone who finds your dashboard URL can read every token and add
accounts. The page prompts for the key once and keeps it for the tab.

⚠️ On Render's free plan the filesystem is wiped on every deploy, so a file saved
from the browser disappears on the next release. For tokens that survive redeploys,
either commit `tokens.txt` (it is gitignored, so force-add it in a private repo) or
keep using the `BOT_TOKENS` env var, which is written into the file once at startup.

## Louder audio

The mixer is 32-bit float and ffmpeg converts to Int16 only at the very end, so
gain can never wrap before the chain sees it. The chain is:

1. **Mixer gain** (`AUDIO_VOLUME`, default 1000x) — feeds peak normalisation
2. **Output preamp** (8x / 18 dB) — raises average loudness after normalisation
3. **Drive** (`AUDIO_DRIVE`, default 30) — a light `acompressor`
4. **Target LUFS** (`AUDIO_TARGET_LUFS`, default **−5**) — peak normalisation, in the mixer
5. **Limiter** (`AUDIO_LIMITER`, on) — `alimiter` at 0.95, with headroom for Opus

### Why normalisation is not ffmpeg's loudnorm

`loudnorm` is the right tool for a file and the wrong tool for a live pipe: it is
an EBU R128 pass, so it **measures before it emits**. Measured on a live stream:

| Chain | first audio byte at the player |
| --- | --- |
| alimiter only | **0.0 s** |
| loudnorm I=−5 | **2.6 s** |
| loudnorm I=−9 | **2.6 s** |

Two and a half seconds of dead air at the start of every track, on a host slow
enough to make it worse, is the difference between hearing music and hearing
nothing — while every status line still reported "playing".

Normalisation therefore lives in the **mixer** (`PcmMixer.setAutoGain`), which
knows the running level from the very first block. It tracks a slowly-moving
peak and nudges the gain toward the ceiling, up to 1000x for a genuinely quiet
file. The ffmpeg chain is left with compression and a limiter, both of which act
instantly.

### Why a target is needed at all

A **fixed** pre-gain cannot make a quiet track loud. Once a source's peak falls
below the compressor threshold, nothing pushes it into the limiter and the output
simply stays as quiet as the source — a 20 LUFS spread between a hot track and a
quiet one, which is exactly the "some tracks play, some don't" behaviour. Measured
on the delivered s16le with the current chain, starting from a deliberately quiet
source:

| | Result |
| --- | --- |
| first audio at the player | **1.0 s** |
| audio delivered | **100% of real time** |
| peak delivered | **0.94 (−0.6 dBFS)** |

Set `AUDIO_TARGET_LUFS=-9` for something tamer; `-5` is the loudest.

### The hard ceiling: 0 dBFS

There is no volume number that goes past this. Measured on the real s16le
output the voice gateway receives, not the float level before encoding:

| Pre-gain | LUFS | True peak | Clipped samples |
| --- | --- | --- | --- |
| 1x | −5.0 | −3.3 dBFS | 0 |
| 12x | −5.0 | −2.6 dBFS | 0 |
| 100x | −5.0 | −1.6 dBFS | 0 |
| 1000x | −5.0 | −1.6 dBFS | 0 |

0 dBFS is digital full scale. Past it there is no "louder", only clipping, so
`AUDIO_VOLUME` is mixer-side input gain; peak normalisation keeps it from
causing clipping. The separate 8x output preamp raises average loudness, and the
limiter catches peaks. Raising the mixer gain alone past its normalisation point
does not make the delivered stream louder.

**If it is still quiet, the loss is not in this chain.** Check, in order:

1. **Audio flow** on the dashboard — if the kB counter is stuck, the host is
   CPU-starved and no audio is being produced at all.
2. **Your own Discord volume slider** — it is per-user, and no bot can change
   it. Every listener has to turn theirs up.

### Also fixed along the way

- **Ducking triggered on silence.** The browser sends a 20 ms frame whether or not
  anyone speaks, and ducking keyed off that packet arriving, so with the mic page
  open the music sat at 35% — a permanent **9.1 dB cut**. Ducking now requires
  actual signal above −48 dBFS, and holds for 700 ms so it does not pump between
  words. The default duck level is 0.8 rather than 0.35.
- **The heavy compressor.** At 19:1 it was doing the limiter's job, adding
  distortion for no measurable gain. It is now a light touch.

The dashboard shows **Music gain**, **Mic input** and **Audio flow** live, so it
is visible whether the music is being ducked, whether the mic is carrying signal,
and which stage of the chain stopped.

The chain is set with environment variables (`AUDIO_VOLUME`, `AUDIO_DRIVE`,
`AUDIO_LIMITER`, `AUDIO_TARGET_LUFS`, `AUDIO_DUCK_MUSIC`, `AUDIO_DUCK_LEVEL`,
`MIC_GAIN`) or via `POST /audio/loudness`; the dashboard only reports the values
in force, and the Mic Routing page still exposes the mic-side ones.

If it still sounds quiet after this, the limit is upstream: Discord's own client
volume slider is per-user and no bot can change it.

### When the logs say "playing" but nothing is audible

The bus running and the join succeeding do not prove audio was sent, so the
dashboard traces the chain and names the first stage that produced nothing:

| Row | Meaning if it looks wrong |
| --- | --- |
| **Audio flow** | `decoded N kB · bus up · N blocks · N subscribed · player playing` |
| | `MIXER IS PRODUCING SILENCE` — audio reached the bus but the mix is zeros |
| | `NOTHING SUBSCRIBED` — audio is playing into a bus no account is attached to |
| | `bus DOWN` / `player buffering` — the ffmpeg or player stage stopped |
| | `N skipped (too slow)` — the host cannot keep real time; see below |
| **Music gain** | lower than expected means ducking is active |
| **Mic input** | `connected but silent` means ducking should *not* be active |

One stall bug this exposed: the mixer's slow-consumer guard did
`return` instead of skipping one block, which abandoned every remaining block in
that tick. Since a stalled consumer never drains, the mixer went permanently
silent instead of catching up. It now skips a single block and counts it, so a
slow host loses a block rather than all of them.

## Mic routing

`/mic-route` captures the browser mic (echo cancellation, noise suppression and
auto gain off), resamples to 48 kHz mono with an AudioWorklet and streams 20 ms PCM
frames over a WebSocket to `/mic/stream`. The server mixes them into per-account buses:

| Route | What the account hears |
| --- | --- |
| `mix` | music + mic (default) |
| `music` | music only |
| `mic` | mic only |
| `off` | nothing (unsubscribed) |

Set the default with `MIC_ROUTE_DEFAULT` or per account from the routing table.
Music is decoded once and fanned out, so every account stays in sync.

Playback is throttled in software, not by ffmpeg. ffmpeg decodes a three-minute
track in about a second, so after every chunk the server checks how far ahead the
mixers are and pauses the decoder until they catch up (300 ms ahead = pause,
100 ms = resume). The mixers buffer 600 ms, so nothing is ever dropped and
nothing is ever buffered beyond a few hundred kB.

Measured on a 3-minute file: 112 ms from *Play* to the first sample, 0% silent
blocks over 12 s, memory flat. An earlier version buffered the decoded track in
memory instead, which meant ~8 GB of copying per track - that was the delay, and
on a small container it got the process throttled or killed, which surfaced as
`ffmpeg exited with code 255`.

## Voice flags actually reach Discord

**Mute All**, **Unmute All**, **Deafen All** and **Undeafen All** used to do
nothing at all while an account was already in a voice channel.

`selfMute` / `selfDeaf` are not properties you can set on a live connection —
they travel with `joinVoiceChannel()`, and calling that again for an account
that is already connected returns the **existing** connection without
reconfiguring it. The handlers worked around this by calling `joinChannel()`,
which short-circuits with *"Already in channel"* and returns before
`joinVoiceChannel()` is ever reached. So the buttons set a JavaScript variable,
reported success, and changed nothing on Discord.

This matters far beyond the buttons not working: **Discord discards the audio of
a self-muted or self-deafened account.** An account muted by one stray click
stayed muted, every upload afterwards played into silence, and the whole audio
chain kept reporting that it was healthy. Pressing *Play* was supposed to clear
that leftover mute, and it silently failed the same way.

Each account now records the flags Discord was actually given, so a flag change
forces a genuine re-join, and *Play* clears a leftover mute or deaf on exactly
the accounts that still have one. Accounts Discord already agrees with are left
alone, so toggling a flag with 20-odd accounts connected re-joins only the ones
that need it.

The regression test asserts against the values handed to `joinVoiceChannel()`
rather than the server's own variables — checking the variable is what let this
break while every test passed.

## Logging

Discord re-emits `stateChange` on every heartbeat, which used to bury the log in
`ready -> ready` spam, and the per-keepalive "still active" line fired every 15 s
per account. Both are now quiet: real transitions only, and one line per account
per hour. When ffmpeg cannot decode a file, the reason from its stderr is included
in the error rather than a bare exit code.

## Render configuration

Use these values in Render:

- Runtime: Node
- Build Command: `npm install`
- Start Command: `npm start`
- Environment Variables:
  - `HOST=0.0.0.0`
  - `PORT=10000`
  - `TOKENS_FILE=tokens.txt`
  - `MAX_BOTS=0` (0 = unlimited)
  - `AUDIO_VOLUME=12`, `AUDIO_DRIVE=40`, `AUDIO_LIMITER=true`
  - `MIC_GAIN=6`, `MIC_ROUTE_DEFAULT=mix`
  - `VOICE_CHANNEL_IDS=your-channel-id-here` (only needed with `AUTO_JOIN=true`)

## HTTP endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/` | dashboard |
| GET | `/token-file` | token file page |
| GET | `/mic-route` | mic routing page |
| GET | `/mic-worklet.js` | AudioWorklet used by the mic page |
| GET | `/health`, `/status`, `/settings` | health, bot status, full settings |
| GET | `/tokens` | masked token list (raw tokens are never served here) |
| GET | `/api/tokens/file` | raw file content — needs `TOKEN_FILE_KEY` if set |
| POST | `/api/tokens/append` | add one or many tokens to the file |
| POST | `/api/tokens/save` | replace the file with the pasted content |
| POST | `/tokens/reload` | re-read the token file |
| POST | `/tokens/delete` | remove a token **from the file** |
| GET | `/channels` | voice channels visible to an account (`?index=N`) |
| POST | `/join`, `/stay`, `/leave` | voice channel control |
| POST | `/audio/upload`, `/audio/play`, `/audio/stop` | music player |
| POST | `/audio/loudness` | volume / drive / LUFS / limiter / ducking |
| POST | `/audio/mute`, `/audio/unmute`, `/audio/deafen`, `/audio/undeafen` | voice flags |
| WS | `/mic/stream` | mic PCM stream |
| GET | `/mic/status` | mic client + packet counters |
| POST | `/mic/routing`, `/mic/stop` | routing, drop mic clients |

## Tests

```
npm test
```

Covers the token file parser, the PCM mixer, the loudness filter builder, the
inline page scripts, and a full server smoke test (fake Discord client + fake
ffmpeg) that streams mic audio over a real WebSocket and checks the routing.

## Notes

- `ffmpeg-static` provides ffmpeg; override with `FFMPEG_PATH` if you want your own.
- This project drives user accounts through `discord.js-selfbot-v13`, which is
  against the Discord Terms of Service and the most common cause of account bans.
  Use it on accounts you are willing to lose, and prefer real bot tokens.

