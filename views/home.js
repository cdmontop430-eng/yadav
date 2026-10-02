const { BASE_STYLES } = require('./styles');

// Dashboard: token file status, voice control, loudness control, bot list.
function renderHomePage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Veera.exe Self Bot Monitor</title>
  <style>${BASE_STYLES}</style>
</head>
<body>
  <h1>Veera.exe Self Bot Monitor</h1>
  <p>Self bot monitor for Veera.exe. Tokens load from a text file, audio runs through a louder chain, and the mic can be routed per account.</p>

  <div class="nav">
    <a href="/">Dashboard</a>
    <a href="/token-file">Token File</a>
    <a href="/mic-route">Mic Routing</a>
  </div>

  <div class="card">
    <h2>Token Manager</h2>
    <p class="hint">Tokens live in a text file, one per line. Paste a single token or a whole list here, or edit the file itself on the <a href="/token-file">Token File</a> page. Blank lines and <code>#</code> comments are ignored and duplicates are skipped.</p>
    <div class="kv"><span>Token file</span><span class="mono" id="tokenFilePath">loading…</span></div>
    <div class="kv"><span>Tokens in file</span><span id="tokenFileCount">loading…</span></div>
    <div class="kv"><span>Last sync</span><span id="tokenFileSync">loading…</span></div>

    <div class="form-row" style="margin-top:18px;">
      <input type="text" id="tokenInput" placeholder="Paste one token" />
    </div>
    <div class="form-row">
      <textarea id="tokenBulkInput" class="short" placeholder="Or paste many at once, one per line"></textarea>
    </div>

    <div class="actions">
      <button id="addTokenBtn" style="background:#22c55e;color:#0f172a;">Add Token</button>
      <button id="addBulkBtn" style="background:#8b5cf6;color:#fff;">Add All</button>
      <a href="/token-file" style="flex:1 1 160px; text-align:center; padding:14px 18px; border-radius:14px; background:#0ea5e9;color:#fff;font-weight:700;">Edit tokens.txt</a>
    </div>
    <div class="actions" style="margin-top:10px;">
      <button id="reloadTokensBtn" style="background:#475569;color:#fff;">Reload token file</button>
      <button id="refreshTokensBtn" style="background:#475569;color:#fff;">Refresh</button>
    </div>
    <div id="tokenMessage" class="msg"></div>
  </div>

  <div class="card">
    <h2>Voice Channel Control</h2>
    <div class="form-row">
      <select id="accountSelect"><option value="">Reading accounts…</option></select>
    </div>
    <div class="form-row">
      <select id="channelSelect"><option value="">Pick a voice channel</option></select>
    </div>
    <div class="actions">
      <button id="pickChannelBtn" style="background:#0ea5e9;color:#fff;">Load channels</button>
      <button id="useChannelBtn" style="background:#6366f1;color:#fff;">Use selected</button>
    </div>
    <div class="form-row" style="margin-top:20px;">
      <input id="inputGuild" placeholder="Guild ID (optional)" />
      <input id="inputChannel" placeholder="Voice Channel ID" />
    </div>
    <div class="actions">
      <button id="joinBtn" style="background:#22c55e;color:#0f172a;">Join Channel</button>
      <button id="stay" style="background:#0ea5e9;color:#fff;">Rejoin Saved Channel</button>
      <button id="leave" style="background:#ef4444;color:#fff;">Leave Channel</button>
      <button id="refresh" style="background:#475569;color:#fff;">Refresh Status</button>
    </div>
    <div class="hint" style="margin-top:12px;">Accounts that cannot see the channel (not in that server) fail the join and say so under Accounts below - they need joining the server first.</div>
    <div id="message" class="msg"></div>
  </div>

  <div class="card">
    <h2 style="color:#f43f5e;">God Volume Audio Player</h2>
    <div class="kv"><span>Audio file</span><span class="mono" id="audioFileName">-</span></div>
    <div class="kv"><span>ffmpeg</span><span class="mono" id="ffmpegState">-</span></div>
    <div class="kv"><span>Accounts in voice</span><span id="connectedState">-</span></div>
    <div class="kv"><span>Voice flags</span><span id="flagState">-</span></div>
    <div class="kv"><span>Music gain</span><span id="gainState">-</span></div>
    <div class="kv"><span>Mic input</span><span id="micLevelState">-</span></div>
    <div class="kv"><span>Audio flow</span><span id="flowState">-</span></div>
    <div class="kv"><span>Loudness chain</span><span id="chainState">-</span></div>
    <div class="control" style="margin-top:16px;">
      <label for="musicGainSlider">Output gain <span id="musicGainReadout">100x</span></label>
      <input type="range" id="musicGainSlider" min="0" max="1000" step="1" value="1000" aria-label="Post-normalization output gain, logarithmic scale" />
      <div class="form-row" style="margin-top:8px;">
        <input type="number" id="musicGainInput" min="1" max="100" step="0.5" value="100" aria-label="Post-normalization output gain multiplier" />
      </div>
      <div class="hint">Applied after normalization. Higher gain pushes more audio into the limiter and can increase distortion.</div>
      <div id="musicGainMessage" class="msg" role="status" aria-live="polite"></div>
    </div>
    <div class="form-row">
      <input type="file" id="audioFile" accept="audio/*" />
    </div>

    <div class="actions">
      <button id="uploadPlayBtn" style="background:#8b5cf6;color:#fff;">Upload &amp; Play to All</button>
      <button id="playSavedBtn" style="background:#0ea5e9;color:#fff;">Play Saved Audio</button>
      <button id="stopAudioBtn" style="background:#ef4444;color:#fff;">Stop Audio</button>
    </div>
    <div class="control" style="margin-top:16px;">
      <label>Browser preview boost: <span id="previewBoostDisplay">6.0x</span></label>
      <input type="range" id="previewBoost" min="1" max="100" step="0.5" value="6" />
    </div>
    <div class="actions" style="margin-top:10px;">
      <button id="previewLoudBtn" style="background:#f59e0b;color:#111827;">Preview Loud Audio</button>
      <button id="stopPreviewBtn" style="background:#ef4444;color:#fff;">Stop Preview</button>
    </div>
    <audio id="browserPreviewAudio" controls style="width:100%; margin-top:12px;"></audio>
    <div class="actions" style="margin-top:16px;">
      <button id="muteAllBtn" style="background:#4b5563;color:#fff;">Mute All</button>
      <button id="unmuteAllBtn" style="background:#10b981;color:#fff;">Unmute All</button>
      <button id="deafAllBtn" style="background:#4b5563;color:#fff;">Deafen All</button>
      <button id="undeafAllBtn" style="background:#3b82f6;color:#fff;">Undeafen All</button>
    </div>
    <div class="actions" style="margin-top:16px;">
      <a href="/mic-route" style="flex:1 1 160px; text-align:center; padding:14px 18px; border-radius:14px; background:#db2777;color:#fff;font-weight:700;">Open Mic Routing</a>
    </div>
    <div id="audioMessage" class="msg"></div>
  </div>

  <div class="card">
    <h2>Browser Mic Enhancer</h2>
    <p class="hint">Optional. Patches <code>getUserMedia</code> on this page so a voice app running in this tab captures your mic through the boosted, un-processed chain (echo cancellation, noise suppression and auto gain disabled). Reload the page after toggling.</p>
    <div class="control check">
      <input type="checkbox" id="enhancerCheck" />
      <label for="enhancerCheck">Enable browser mic enhancer</label>
    </div>
    <div class="control">
      <label>Enhancer output gain: <span id="enhancerGainDisplay">1.0x</span></label>
      <input type="range" id="enhancerGain" min="0.1" max="100" step="0.1" value="1" />
    </div>
    <div id="enhancerMessage" class="msg"></div>
  </div>

  <div class="card" id="bots"></div>

  <script>
    var el = function (id) { return document.getElementById(id); };
    var post = function (url, body) {
      return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
      }).then(function (res) { return res.json(); });
    };

    var statusEl = el('message');
    var tokenMessageEl = el('tokenMessage');
    var tokenInput = el('tokenInput');
    var tokenBulkInput = el('tokenBulkInput');
    var apiKey = sessionStorage.getItem('veera.tokenKey') || '';
    var authHeaders = function (extra) {
      var headers = extra || {};
      if (apiKey) headers['x-token-key'] = apiKey;
      return headers;
    };

    var addTokens = function (value) {
      if (!value) {
        tokenMessageEl.textContent = 'Paste a token first.';
        return;
      }
      tokenMessageEl.textContent = 'Adding to the token file...';
      fetch('/api/tokens/append', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ tokens: value })
      }).then(function (res) {
        return res.json().then(function (payload) {
          if (res.status === 401) {
            var key = window.prompt('This token file is protected. Enter TOKEN_FILE_KEY:');
            if (key) {
              apiKey = key;
              sessionStorage.setItem('veera.tokenKey', key);
              return addTokens(value);
            }
            tokenMessageEl.textContent = payload.error || 'Token file key required.';
            return;
          }
          tokenMessageEl.textContent = payload.status || payload.error || 'Done';
          tokenInput.value = '';
          tokenBulkInput.value = '';
          return Promise.all([fetchStatus(), fetchSettings()]);
        });
      }).catch(function (error) {
        tokenMessageEl.textContent = 'Error: ' + error.message;
      });
    };

    el('addTokenBtn').addEventListener('click', function () {
      addTokens(tokenInput.value.trim());
    });

    el('addBulkBtn').addEventListener('click', function () {
      addTokens(tokenBulkInput.value.trim());
    });

    [tokenInput, tokenBulkInput].forEach(function (field) {
      field.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          addTokens(field.value.trim());
        }
      });
    });
    var botsEl = el('bots');
    var audioMessage = el('audioMessage');
    var guildInput = el('inputGuild');
    var channelInput = el('inputChannel');
    var previewAudio = el('browserPreviewAudio');
    var previewBoost = el('previewBoost');
    var previewBoostDisplay = el('previewBoostDisplay');
    var musicGainSlider = el('musicGainSlider');
    var musicGainInput = el('musicGainInput');
    var musicGainReadout = el('musicGainReadout');
    var musicGainMessage = el('musicGainMessage');
    var previewAudioChain = null;
    var gainSaveTimer = null;

    var sliderToMusicGain = function (position) {
      return Math.pow(100, Number(position) / 1000);
    };

    var musicGainToSlider = function (gain) {
      return Math.round(1000 * Math.log(Number(gain)) / Math.log(100));
    };

    var renderMusicGain = function (value) {
      var gain = Math.max(1, Math.min(100, Number(value) || 1));
      musicGainSlider.value = String(musicGainToSlider(gain));
      musicGainInput.value = String(Number(gain.toFixed(1)));
      musicGainReadout.textContent = (gain >= 100 ? gain.toFixed(0) : gain.toFixed(1)) + 'x';
    };

    var saveMusicGain = function (value) {
      var gain = Number(value);
      if (!Number.isFinite(gain)) return;
      gain = Math.max(1, Math.min(100, gain));
      renderMusicGain(gain);
      musicGainMessage.textContent = 'Saving gain...';
      post('/audio/loudness', { outputGain: gain }).then(function (data) {
        if (data.error) throw new Error(data.error);
        renderMusicGain(data.settings.loudness.outputGain);
        musicGainMessage.textContent = 'Gain saved for all music buses.';
      }).catch(function (error) {
        musicGainMessage.textContent = 'Could not save gain: ' + error.message;
        fetchSettings();
      });
    };

    var ensurePreviewAudioChain = function () {
      if (previewAudioChain) return previewAudioChain;
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;

      var ctx = new Ctx();
      var source = ctx.createMediaElementSource(previewAudio);
      var gain = ctx.createGain();
      var compressor = ctx.createDynamicsCompressor();

      compressor.threshold.value = -18;
      compressor.knee.value = 28;
      compressor.ratio.value = 4;
      compressor.attack.value = 0.01;
      compressor.release.value = 0.25;
      gain.gain.value = Number(previewBoost.value) || 1;

      source.connect(gain);
      gain.connect(compressor);
      compressor.connect(ctx.destination);

      previewAudioChain = { ctx: ctx, gain: gain, compressor: compressor, source: source };
      return previewAudioChain;
    };

    var setPreviewBoost = function (value) {
      var boost = Number(value) || 1;
      previewBoostDisplay.textContent = boost.toFixed(1) + 'x';
      if (previewAudioChain && previewAudioChain.gain) {
        previewAudioChain.gain.gain.value = boost;
      }
    };

    var renderTokenFile = function (info) {
      var file = (info && info.tokenFile) || {};
      el('tokenFilePath').textContent = file.path || 'unknown';
      el('tokenFileCount').textContent = String(file.count === undefined ? 0 : file.count);
      el('tokenFileSync').textContent = file.lastSyncAt
        ? new Date(file.lastSyncAt).toLocaleTimeString() + ' (' + (file.lastTrigger || 'manual') + ')'
        : 'never';
    };

    // Walk the chain and name the first stage that produced nothing. Without
    // this the logs say "bus running" and "join ok" while nothing is audible.
    var describeFlow = function (audio) {
      var flow = audio.flow;
      if (!flow || !flow.playing) return 'nothing playing';

      var parts = ['decoded ' + Math.round(flow.decodedBytes / 1024) + ' kB'];
      var bus = flow.buses && (flow.buses.mix || flow.buses.music);
      if (!bus) return parts.join(' · ') + ' · no bus';

      // Report the deepest failure first: a dead mixer makes every later stage
      // meaningless, and a paused decoder never advances no matter what.
      if (!bus.clockRunning) return parts.join(' · ') + ' · MIXER CLOCK NOT RUNNING';
      parts.push(bus.running ? 'bus up' : 'bus DOWN');
      parts.push(bus.rendered + ' blocks');

      if (bus.rendered === 0) {
        return parts.join(' · ') + ' · MIXER RENDERING NOTHING (host too slow?)';
      }
      if (bus.nonSilent === 0) return parts.join(' · ') + ' · MIXER IS PRODUCING SILENCE';
      if (bus.skipped > 0) parts.push(bus.skipped + ' skipped (too slow)');

      parts.push(bus.subscribed + ' subscribed');
      if (bus.subscribed === 0) return parts.join(' · ') + ' · NOTHING SUBSCRIBED';

      parts.push('player ' + (bus.playerState || 'none'));
      return parts.join(' · ');
    };

    // A server can look perfectly healthy and still be inaudible: no ffmpeg
    // binary, every account self-muted, or nobody in a voice channel at all.
    // Show those three plainly instead of leaving a silent page.
    var renderAudioState = function (info) {
      var audio = (info && info.audio) || {};
      var file = audio.file || '';
      el('audioFileName').textContent = audio.fileExists
        ? file
        : (file ? file + ' (missing - upload a file)' : 'none uploaded');

      el('ffmpegState').textContent = audio.ffmpegAvailable
        ? 'ready'
        : 'missing - nothing can play (set FFMPEG_PATH)';

      el('connectedState').textContent = String(audio.connected === undefined ? 0 : audio.connected)
        + ' in a voice channel';

      var flags = [];
      if (audio.mute) flags.push('all muted');
      if (audio.deaf) flags.push('all deafened');
      el('flagState').textContent = flags.length
        ? flags.join(', ') + ' - Discord sends nothing while muted'
        : 'unmuted (audible)';

      // The gain actually in force. This is the number that explains "why is it
      // quiet": ducking cuts it, and the limiter - not this value - sets the
      // final output level.
      el('gainState').textContent = Number(audio.musicGain || 0).toFixed(2) + 'x pre-gain'
        + (audio.ducked ? ' (ducked for the mic)' : '');

      var mic = (info && info.mic) || {};
      var level = Number(mic.level || 0);
      el('micLevelState').textContent = mic.clients
        ? mic.active
          ? 'live, ' + level.toFixed(3) + ' peak'
          : 'connected but silent (' + level.toFixed(4) + ')'
        : 'not connected';

      // Walk the chain and name the first stage that produced nothing. Without
      // this the logs say "bus running" and "join ok" while nothing is audible.
      el('flowState').textContent = describeFlow(audio);
    };

    var renderSettings = function (info) {
      var loudness = (info && info.loudness) || {};
      renderTokenFile(info);
      renderAudioState(info);
      renderChainSummary(loudness);
      if (loudness.outputGain !== undefined) renderMusicGain(loudness.outputGain);
    };

    var renderChainSummary = function (loudness) {
      if (!loudness || loudness.volume === undefined) return;
      el('chainState').textContent = (loudness.limiter === false ? 'limiter off' : 'limiter to -0.45 dBFS')
        + (loudness.targetLufs ? ' · ' + loudness.targetLufs + ' LUFS' : '');
    };

    var renderStatus = function (data) {
      var list = (data && data.bots) || [];
      statusEl.textContent = 'Loaded ' + list.length + ' bot' + (list.length !== 1 ? 's' : '') + '.';

      // Account picker for the channel list.
      var select = el('accountSelect');
      var previous = select.value;
      var ready = list.filter(function (bot) { return bot.ready; });
      if (ready.length) {
        select.innerHTML = '<option value="">First ready account</option>' + ready.map(function (bot) {
          return '<option value="' + (bot.index - 1) + '">Account ' + bot.index
            + (bot.tag ? ' · ' + bot.tag : '') + '</option>';
        }).join('');
        select.value = previous;
      } else {
        select.innerHTML = '<option value="">No accounts ready yet</option>';
      }

      if (!list.length) {
        botsEl.innerHTML = '<p>No tokens in the token file yet. Add one, save the file, then press Reload.</p>';
        return;
      }

      botsEl.innerHTML = list.map(function (bot) {
        return '<div class="bot">'
          + '<div><strong>Account ' + bot.index + '</strong> <span class="' + (bot.ready ? 'status-ready' : 'status-offline') + '">' + (bot.ready ? 'Ready' : 'Offline') + '</span></div>'
          + '<div><span>Voice:</span><span class="status-vc">' + (bot.voiceState || 'disconnected') + '</span></div>'
          + '<div><span>Channel:</span><span>' + (bot.channelId || 'None') + '</span></div>'
          + '<div><span>Guild:</span><span>' + (bot.guildId || 'None') + '</span></div>'
          + '<div><span>Route:</span><span>' + (bot.route || 'mix') + '</span></div>'
          + '</div>';
      }).join('');
    };

    var fetchStatus = function () {
      return fetch('/status').then(function (res) { return res.json(); }).then(renderStatus).catch(function () {
        statusEl.textContent = 'Failed to load status';
        botsEl.innerHTML = '';
      });
    };

    var fetchSettings = function () {
      return fetch('/settings').then(function (res) { return res.json(); }).then(renderSettings).catch(function () {});
    };

    el('reloadTokensBtn').addEventListener('click', function () {
      tokenMessageEl.textContent = 'Reloading token file...';
      post('/tokens/reload').then(function (payload) {
        tokenMessageEl.textContent = payload.status || payload.error || 'Reloaded';
        return Promise.all([fetchStatus(), fetchSettings()]);
      }).catch(function (error) {
        tokenMessageEl.textContent = 'Error: ' + error.message;
      });
    });

    el('refreshTokensBtn').addEventListener('click', function () { fetchStatus(); fetchSettings(); });
    el('refresh').addEventListener('click', fetchStatus);

    musicGainSlider.addEventListener('input', function () {
      renderMusicGain(sliderToMusicGain(musicGainSlider.value));
      musicGainMessage.textContent = 'Gain changes apply to music sent to Discord.';
      clearTimeout(gainSaveTimer);
      gainSaveTimer = setTimeout(function () { saveMusicGain(musicGainInput.value); }, 250);
    });

    musicGainSlider.addEventListener('change', function () {
      clearTimeout(gainSaveTimer);
      saveMusicGain(sliderToMusicGain(musicGainSlider.value));
    });

    musicGainInput.addEventListener('input', function () {
      var gain = Number(musicGainInput.value);
      if (!Number.isFinite(gain) || gain < 1 || gain > 100) return;
      musicGainReadout.textContent = (gain >= 100 ? gain.toFixed(0) : gain.toFixed(1)) + 'x';
      musicGainSlider.value = String(musicGainToSlider(gain));
    });

    musicGainInput.addEventListener('change', function () {
      if (musicGainInput.value !== '') saveMusicGain(musicGainInput.value);
    });

    var loadChannels = function () {
      var select = el('accountSelect');
      var index = select.value;
      statusEl.textContent = 'Loading voice channels...';
      return fetch('/channels' + (index === '' ? '' : '?index=' + encodeURIComponent(index)))
        .then(function (res) { return res.json(); })
        .then(function (payload) {
          var target = el('channelSelect');
          if (!payload.guilds || !payload.guilds.length) {
            target.innerHTML = '<option value="">No voice channels found for that account</option>';
            statusEl.textContent = 'No voice channels visible. If this account is not in the server, add it there first.';
            return;
          }

          target.innerHTML = payload.guilds.map(function (guild) {
            return '<optgroup label="' + guild.name + '">'
              + guild.channels.map(function (channel) {
                return '<option value="' + channel.id + '" data-guild="' + guild.id + '">'
                  + channel.name + ' (' + channel.id + ')</option>';
              }).join('')
              + '</optgroup>';
          }).join('');

          statusEl.textContent = 'Loaded ' + payload.guilds.length + ' server(s) from '
            + (payload.account ? payload.account.tag || 'account ' + payload.account.index : 'an account') + '.';
        })
        .catch(function (error) { statusEl.textContent = 'Error: ' + error.message; });
    };

    el('pickChannelBtn').addEventListener('click', loadChannels);

    el('useChannelBtn').addEventListener('click', function () {
      var option = el('channelSelect').selectedOptions[0];
      if (!option || !option.value) {
        statusEl.textContent = 'Pick a channel from the list first.';
        return;
      }
      channelInput.value = option.value;
      guildInput.value = option.dataset.guild || '';
      statusEl.textContent = 'Channel filled in. Press Join Channel.';
    });

    el('accountSelect').addEventListener('change', loadChannels);

    el('joinBtn').addEventListener('click', function () {
      var channelId = channelInput.value.trim();
      if (!channelId) {
        statusEl.textContent = 'Channel ID is required to join.';
        return;
      }
      statusEl.textContent = 'Joining bots to channel...';
      post('/join', { channelId: channelId, guildId: guildInput.value.trim() }).then(function (data) {
        statusEl.textContent = data.status || 'Join requested';
        fetchStatus();
      }).catch(function (error) { statusEl.textContent = 'Error: ' + error.message; });
    });

    el('stay').addEventListener('click', function () {
      statusEl.textContent = 'Rejoining saved channel...';
      post('/stay').then(function (data) { statusEl.textContent = data.status || 'Stay requested'; fetchStatus(); });
    });

    el('leave').addEventListener('click', function () {
      statusEl.textContent = 'Leaving voice channel...';
      post('/leave').then(function (data) { statusEl.textContent = data.status || 'Leave requested'; fetchStatus(); });
    });

    el('uploadPlayBtn').addEventListener('click', function () {
      var file = el('audioFile').files[0];
      if (!file) {
        audioMessage.textContent = 'Please select an audio file first.';
        return;
      }
      audioMessage.textContent = 'Uploading audio file...';
      fetch('/audio/upload', { method: 'POST', body: file }).then(function (res) {
        if (!res.ok) throw new Error('Upload failed');
        audioMessage.textContent = 'Playing audio to all bots...';
        return post('/audio/play');
      }).then(function (data) {
        audioMessage.textContent = (data && (data.status || data.error)) || 'Playing';
        fetchSettings();
      }).catch(function (error) { audioMessage.textContent = 'Error: ' + error.message; });
    });

    el('playSavedBtn').addEventListener('click', function () {
      audioMessage.textContent = 'Playing saved audio to all bots...';
      post('/audio/play').then(function (data) {
        audioMessage.textContent = (data && (data.status || data.error)) || 'Playing';
        fetchSettings();
      }).catch(function (error) { audioMessage.textContent = 'Error: ' + error.message; });
    });

    el('stopAudioBtn').addEventListener('click', function () {
      audioMessage.textContent = 'Stopping audio...';
      post('/audio/stop').then(function (data) { audioMessage.textContent = (data && data.status) || 'stopped'; });
    });

    previewBoost.addEventListener('input', function (event) {
      setPreviewBoost(event.target.value);
    });

    el('previewLoudBtn').addEventListener('click', function () {
      var file = el('audioFile').files[0];
      if (!file) {
        audioMessage.textContent = 'Pick an audio file first to preview it loudly.';
        return;
      }
      var chain = ensurePreviewAudioChain();
      if (!chain) {
        audioMessage.textContent = 'This browser does not support WebAudio, so no loud preview can be created.';
        return;
      }
      try {
        previewAudio.src = URL.createObjectURL(file);
        previewAudio.load();
        chain.ctx.resume();
        previewAudio.play();
        audioMessage.textContent = 'Loud preview playing in this browser.';
      } catch (error) {
        audioMessage.textContent = 'Error: ' + error.message;
      }
    });

    el('stopPreviewBtn').addEventListener('click', function () {
      previewAudio.pause();
      previewAudio.currentTime = 0;
      audioMessage.textContent = 'Preview stopped.';
    });

    var voiceCommand = function (url) {
      audioMessage.textContent = 'Updating voice state...';
      post(url).then(function (data) {
        audioMessage.textContent = (data && (data.status || data.error)) || 'done';
        fetchStatus();
        fetchSettings();
      }).catch(function (error) { audioMessage.textContent = 'Error: ' + error.message; });
    };

    el('muteAllBtn').addEventListener('click', function () { voiceCommand('/audio/mute'); });
    el('unmuteAllBtn').addEventListener('click', function () { voiceCommand('/audio/unmute'); });
    el('deafAllBtn').addEventListener('click', function () { voiceCommand('/audio/deafen'); });
    el('undeafAllBtn').addEventListener('click', function () { voiceCommand('/audio/undeafen'); });

    var enhancerMessage = el('enhancerMessage');
    var enhancerCheck = el('enhancerCheck');
    var enhancerGain = el('enhancerGain');
    var enhancerGainDisplay = el('enhancerGainDisplay');

    // Opt-in getUserMedia patch: strips browser voice processing and runs the
    // mic through a boosted chain. window.__CB_GAIN__ is the output gain.
    var enhanceGetUserMedia = function () {
      if (window.__CB__ || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return false;
      window.__CB__ = true;
      window.__CB_GAIN__ = window.__CB_GAIN__ || Number(enhancerGain.value) || 1;

      var oldGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async function (c) {
        if (c && c.audio && c.audio.__raw !== true) {
          c.audio.echoCancellation = false;
          c.audio.noiseSuppression = false;
          c.audio.autoGainControl = false;
        }

        var real = await oldGUM(c);
        if (c && c.audio && c.audio.__raw === true) return real;

        var ctx = new (window.AudioContext || window.webkitAudioContext)();
        await ctx.resume();

        var src = ctx.createMediaStreamSource(real);
        var dst = ctx.createMediaStreamDestination();
        var gain = function (value) { var node = ctx.createGain(); node.gain.value = value; return node; };
        var filter = function (type, frequency, filterGain, q) {
          var node = ctx.createBiquadFilter();
          node.type = type;
          node.frequency.value = frequency;
          node.gain.value = filterGain;
          if (q) node.Q.value = q;
          return node;
        };
        var shaper = function (amount, size) {
          var node = ctx.createWaveShaper();
          var curve = new Float32Array(size || 65536);
          for (var i = 0; i < curve.length; i++) {
            curve[i] = Math.tanh((i * 2 / curve.length - 1) * amount);
          }
          node.curve = curve;
          node.oversample = '4x';
          return node;
        };

        var dry = gain(1);
        src.connect(dry);
        dry.connect(dst);

        var v1 = gain(220);
        var v2 = gain(170);
        var v3 = gain(70);
        var v4 = gain(110);
        var bass = filter('lowshelf', 90, 24);
        var dip = filter('peaking', 1200, -4, 0.8);
        var presence = filter('peaking', 2600, 56, 0.6);
        var air = filter('highshelf', 9000, 44);
        var body = filter('peaking', 1800, 20, 0.5);

        var comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -36;
        comp.knee.value = 20;
        comp.ratio.value = 6;
        comp.attack.value = 0.002;
        comp.release.value = 0.08;
        var compMakeup = gain(12);

        var dist = shaper(6, 44100);
        var sat = shaper(8);

        var conv = ctx.createConvolver();
        var ir = ctx.createBuffer(2, ctx.sampleRate * 3, ctx.sampleRate);
        for (var ch = 0; ch < 2; ch++) {
          var irData = ir.getChannelData(ch);
          for (var j = 0; j < irData.length; j++) {
            irData[j] = (Math.random() * 2 - 1) * Math.pow(1 - j / irData.length, 2.5);
          }
        }
        conv.buffer = ir;
        var reverbGain = gain(0.5);

        var e1D = ctx.createDelay(5.0); e1D.delayTime.value = 0.25;
        var e1F = gain(0.36); e1D.connect(e1F); e1F.connect(e1D);
        var e1W = gain(0.36);
        var e2D = ctx.createDelay(5.0); e2D.delayTime.value = 0.12;
        var e2F = gain(0.16); e2D.connect(e2F); e2F.connect(e2D);
        var e2W = gain(0.16);

        var sub = ctx.createOscillator(); sub.type = 'sine'; sub.frequency.value = 42;
        var subGain = gain(0.16);
        var master = gain(240);
        var limiter = shaper(1.35);
        var baseCurve = limiter.curve;
        var softCurve = new Float32Array(baseCurve.length);
        for (var i = 0; i < softCurve.length; i++) { softCurve[i] = baseCurve[i] * 0.89; }
        limiter.curve = softCurve;

        src.connect(v1); v1.connect(v2); v2.connect(master);
        src.connect(v3); v3.connect(master);
        src.connect(v4); v4.connect(master);
        v1.connect(bass); bass.connect(dip); dip.connect(presence); presence.connect(air); air.connect(body);
        body.connect(comp); comp.connect(compMakeup); compMakeup.connect(dist);
        dist.connect(sat); sat.connect(master);
        sat.connect(conv); conv.connect(reverbGain); reverbGain.connect(master);
        dist.connect(e1D); e1D.connect(e1W); e1W.connect(master);
        dist.connect(e2D); e2D.connect(e2W); e2W.connect(master);
        sub.connect(subGain); subGain.connect(master);
        master.connect(limiter); limiter.connect(dst);
        sub.start();

        window.__CB_MASTER__ = master;
        window.__CB_BYPASS__ = false;
        setInterval(function () {
          if (ctx.state === 'suspended') ctx.resume();
          master.gain.value = 240 * (window.__CB_BYPASS__ ? 0 : (window.__CB_GAIN__ || 1));
        }, 100);

        window.__CB_TOGGLE__ = function () { window.__CB_BYPASS__ = !window.__CB_BYPASS__; };
        return dst.stream;
      };
      return true;
    };

    if (localStorage.getItem('veera.enhancer') === 'on') { enhancerCheck.checked = true; }
    if (window.__CB_GAIN__) { enhancerGain.value = window.__CB_GAIN__; }
    enhancerGainDisplay.textContent = Number(enhancerGain.value).toFixed(1) + 'x';

    if (enhancerCheck.checked) {
      enhanceGetUserMedia();
      enhancerMessage.textContent = 'Audio enhancement enabled for this tab.';
    } else {
      enhancerMessage.textContent = 'Enhancer off. Enable it, then reload the page.';
    }

    enhancerCheck.addEventListener('change', function (event) {
      localStorage.setItem('veera.enhancer', event.target.checked ? 'on' : 'off');
      enhancerMessage.textContent = event.target.checked
        ? 'Enabled - reload the page to apply it to this tab.'
        : 'Disabled - reload the page to remove it.';
    });

    enhancerGain.addEventListener('input', function (event) {
      window.__CB_GAIN__ = Number(event.target.value);
      enhancerGainDisplay.textContent = Number(event.target.value).toFixed(1) + 'x';
    });

    fetchStatus();
    fetchSettings();
    setInterval(function () { fetchStatus(); fetchSettings(); }, 10000);
  </script>
</body>
</html>`;
}

module.exports = { renderHomePage };
