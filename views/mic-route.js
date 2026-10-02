const { BASE_STYLES } = require('./styles');

// Mic routing page: capture the browser mic, stream it to the server over a
// WebSocket and decide which accounts hear music, the mic, both or nothing.
function renderMicRoutePage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Mic Routing · Veera.exe</title>
  <style>${BASE_STYLES}
    canvas { width:100%; height:70px; background:#0f172a; border:1px solid #334155; border-radius:12px; }
    table { width:100%; border-collapse:collapse; font-size:14px; }
    th, td { text-align:left; padding:10px 8px; border-bottom:1px solid rgba(148,163,184,.15); }
    th { color:#94a3b8; font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
    td select { max-width:220px; padding:8px 10px; }
    .ptt { user-select:none; touch-action:none; }
    .live { box-shadow:0 0 0 3px rgba(34,197,94,.35); }
  </style>
</head>
<body>
  <h1>Mic Routing</h1>
  <p>Stream your microphone into the voice channel and route it per account. Audio goes to the server as 48 kHz PCM over a WebSocket, then through the same loudness chain as the music.</p>

  <div class="nav">
    <a href="/">Dashboard</a>
    <a href="/token-file">Token File</a>
    <a href="/mic-route">Mic Routing</a>
  </div>

  <div class="card">
    <h2>Input</h2>
    <div class="form-row">
      <select id="deviceSelect"><option value="">Default microphone</option></select>
    </div>
    <div class="actions">
      <button id="refreshDevices" style="background:#475569;color:#fff;">Refresh devices</button>
      <button id="startBtn" style="background:#22c55e;color:#0f172a;">Start Mic</button>
      <button id="stopBtn" style="background:#ef4444;color:#fff;" disabled>Stop Mic</button>
    </div>

    <div class="control">
      <label>Input gain: <span id="inputGainDisplay">1.0x</span></label>
      <input type="range" id="inputGain" min="0.1" max="10" step="0.1" value="1" />
    </div>

    <div class="control check">
      <input type="checkbox" id="monitorCheck" />
      <label for="monitorCheck">Monitor locally (hear yourself)</label>
    </div>

    <div class="control check">
      <input type="checkbox" id="pttCheck" checked />
      <label for="pttCheck">Push to talk (hold the button or the space bar)</label>
    </div>

    <div class="actions">
      <button id="pttBtn" class="ptt" style="background:#db2777;color:#fff;flex:1 1 220px;">Hold to talk</button>
    </div>

    <div style="margin-top:16px;">
      <canvas id="meter" width="900" height="70"></canvas>
    </div>

    <div class="kv"><span>Input level</span><span id="meterValue">-</span></div>
    <div class="kv"><span>Stream</span><span id="streamState" class="pill off">idle</span></div>
    <div class="kv"><span>Packets sent</span><span id="packetCount">0</span></div>
    <div class="kv"><span>Server</span><span id="serverState">-</span></div>
    <div id="micMessage" class="msg"></div>
  </div>

  <div class="card">
    <h2>Server Mic Settings</h2>
    <div class="control">
      <label>Mic gain sent to Discord: <span id="micGainDisplay">6.0x</span></label>
      <input type="range" id="micGain" min="0.1" max="20" step="0.1" value="6" />
      <div class="hint">Your level, relative to the music. Applied in float, then the same drive + limiter chain runs, so you can be louder than the track without clipping.</div>
    </div>
    <div class="control check">
      <input type="checkbox" id="duckCheck" checked />
      <label for="duckCheck">Duck music while the mic is live</label>
    </div>
    <div class="control">
      <label>Duck level: <span id="duckDisplay">0.35</span></label>
      <input type="range" id="duckLevel" min="0" max="1" step="0.05" value="0.35" />
    </div>
    <div class="actions">
      <button id="forceStop" style="background:#ef4444;color:#fff;">Disconnect mic on server</button>
    </div>
  </div>

  <div class="card">
    <h2>Routing</h2>
    <div class="form-row">
      <select id="defaultRoute">
        <option value="mix">Default: music + mic (mix)</option>
        <option value="music">Default: music only</option>
        <option value="mic">Default: mic only</option>
        <option value="off">Default: silent</option>
      </select>
    </div>
    <div class="hint" style="margin-bottom:16px;">Each account can be pointed at a different bus. "mix" plays music and your mic together, "music" ignores the mic, "mic" only broadcasts your voice, "off" subscribes to nothing.</div>
    <table>
      <thead>
        <tr><th>Account</th><th>Status</th><th>Route</th></tr>
      </thead>
      <tbody id="routingRows"><tr><td colspan="3" class="hint">Loading…</td></tr></tbody>
    </table>
    <div id="routingMessage" class="msg"></div>
  </div>

  <div class="card">
    <h2>How it works</h2>
    <p class="hint">Your browser captures the mic with echo cancellation, noise suppression and auto gain disabled, resamples to 48 kHz mono and sends 20 ms PCM frames to the server. The server mixes them with the music track, applies the drive + limiter chain and pushes the result to every voice connection assigned to that bus, so all accounts stay in sync.</p>
  </div>

  <script>
    var el = function (id) { return document.getElementById(id); };
    var post = function (url, body) {
      return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
      }).then(function (res) { return res.json(); });
    };
    var micMessage = el('micMessage');
    var routingMessage = el('routingMessage');

    var state = {
      ws: null,
      ctx: null,
      stream: null,
      node: null,
      analyser: null,
      monitorGain: null,
      sink: null,
      sending: false,
      packets: 0,
      deviceId: '',
      gain: 1,
      monitorOn: false,
      ptt: true
    };

    var setStreamState = function (label, cls) {
      var pill = el('streamState');
      pill.textContent = label;
      pill.className = 'pill ' + cls;
    };

    var openSocket = function () {
      return new Promise(function (resolve, reject) {
        var protocol = location.protocol === 'https:' ? 'wss://' : 'ws://';
        var socket = new WebSocket(protocol + location.host + '/mic/stream');
        socket.binaryType = 'arraybuffer';

        socket.onopen = function () { resolve(socket); };
        socket.onerror = function () { reject(new Error('Could not open the mic stream')); };
        socket.onclose = function () {
          if (state.ws === socket) {
            state.ws = null;
            setStreamState('disconnected', 'off');
          }
        };

        setTimeout(function () {
          if (socket.readyState !== 1) reject(new Error('Mic stream connection timed out'));
        }, 8000);
      });
    };

    var stop = function (silent) {
      if (state.node) {
        try { state.node.port.onmessage = null; state.node.disconnect(); } catch (error) {}
        state.node = null;
      }
      if (state.stream) {
        state.stream.getTracks().forEach(function (track) { track.stop(); });
        state.stream = null;
      }
      if (state.ws) {
        try { state.ws.close(); } catch (error) {}
        state.ws = null;
      }
      if (state.ctx) {
        try { state.ctx.close(); } catch (error) {}
        state.ctx = null;
      }
      state.sending = false;
      state.analyser = null;
      el('startBtn').disabled = false;
      el('stopBtn').disabled = true;
      el('pttBtn').classList.remove('live');
      setStreamState('idle', 'off');
      if (!silent) micMessage.textContent = 'Mic stopped.';
    };

    var start = function () {
      if (state.ctx) {
        micMessage.textContent = 'Mic is already running.';
        return;
      }

      micMessage.textContent = 'Requesting microphone...';
      var constraints = {
        audio: {
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          __raw: true
        },
        video: false
      };
      if (state.deviceId) constraints.audio.deviceId = { exact: state.deviceId };

      navigator.mediaDevices.getUserMedia(constraints).then(function (stream) {
        state.stream = stream;
        return openSocket().then(function (socket) {
          state.ws = socket;
          var Ctx = window.AudioContext || window.webkitAudioContext;
          var ctx = new Ctx({ sampleRate: 48000 });
          state.ctx = ctx;
          return ctx.audioWorklet.addModule('/mic-worklet.js').then(function () {
            var source = ctx.createMediaStreamSource(stream);
            var inputGain = ctx.createGain();
            inputGain.gain.value = state.gain;

            var analyser = ctx.createAnalyser();
            analyser.fftSize = 1024;
            state.analyser = analyser;

            var monitorGain = ctx.createGain();
            monitorGain.gain.value = state.monitorOn ? 0.9 : 0;
            state.monitorGain = monitorGain;

            var node = new AudioWorkletNode(ctx, 'veera-pcm-tap', {
              numberOfInputs: 1,
              numberOfOutputs: 1,
              outputChannelCount: [1],
              processorOptions: { blockFrames: 960 }
            });
            state.node = node;
            node.port.onmessage = function (event) {
              if (!state.sending || !state.ws || state.ws.readyState !== 1) return;
              state.ws.send(event.data.buffer);
              state.packets += 1;
            };

            source.connect(inputGain);
            inputGain.connect(analyser);
            inputGain.connect(monitorGain);
            monitorGain.connect(ctx.destination);
            inputGain.connect(node);

            // The worklet only posts messages, so keep it pulled with a silent sink.
            var sink = ctx.createGain();
            sink.gain.value = 0;
            node.connect(sink);
            sink.connect(ctx.destination);
            state.sink = sink;

            return ctx.resume();
          });
        });
      }).then(function () {
        el('startBtn').disabled = true;
        el('stopBtn').disabled = false;
        setStreamState('live', 'on');
        micMessage.textContent = 'Mic is live. Hold to talk to send audio.';
        refreshDevices();
      }).catch(function (error) {
        stop(true);
        micMessage.textContent = 'Error: ' + error.message;
      });
    };

    var refreshDevices = function () {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return Promise.resolve();
      return navigator.mediaDevices.enumerateDevices().then(function (devices) {
        var select = el('deviceSelect');
        var current = state.deviceId || select.value;
        var inputs = devices.filter(function (device) { return device.kind === 'audioinput'; });
        select.innerHTML = '<option value="">Default microphone</option>' + inputs.map(function (device, index) {
          return '<option value="' + device.deviceId + '">' + (device.label || 'Microphone ' + (index + 1)) + '</option>';
        }).join('');
        select.value = current;
        state.deviceId = select.value;
      }).catch(function () {});
    };

    var drawMeter = function () {
      var canvas = el('meter');
      var painter = canvas.getContext('2d');
      var samples = new Uint8Array(1024);

      var frame = function () {
        requestAnimationFrame(frame);
        var width = canvas.width;
        var height = canvas.height;
        painter.fillStyle = '#0f172a';
        painter.fillRect(0, 0, width, height);

        var level = 0;
        if (state.analyser) {
          state.analyser.getByteTimeDomainData(samples);
          var sum = 0;
          for (var i = 0; i < samples.length; i++) {
            var value = (samples[i] - 128) / 128;
            sum += value * value;
          }
          level = Math.sqrt(sum / samples.length);
        }

        var db = level > 0.00002 ? 20 * Math.log10(level) : -100;
        var ratio = Math.max(0, Math.min(1, (db + 60) / 60));
        painter.fillStyle = ratio > 0.9 ? '#ef4444' : (ratio > 0.7 ? '#f59e0b' : '#22c55e');
        painter.fillRect(0, (height - 20) / 2, width * ratio, 20);
        el('meterValue').textContent = db <= -99 ? '-inf dB' : db.toFixed(1) + ' dB';
        el('packetCount').textContent = String(state.packets);
      };

      frame();
    };

    var setSending = function (on) {
      if (state.ptt && !on) {
        el('pttBtn').classList.remove('live');
        setStreamState(state.ctx ? 'standby' : 'idle', state.ctx ? 'warn' : 'off');
        return;
      }
      state.sending = on;
      el('pttBtn').classList.toggle('live', on);
      setStreamState(on ? 'transmitting' : (state.ctx ? 'standby' : 'idle'), on ? 'on' : (state.ctx ? 'warn' : 'off'));
    };

    var pttDown = function () { if (state.ctx) setSending(true); };
    var pttUp = function () { if (state.ptt) setSending(false); };

    el('pttBtn').addEventListener('mousedown', pttDown);
    el('pttBtn').addEventListener('touchstart', function (event) { event.preventDefault(); pttDown(); }, { passive: false });
    ['mouseup', 'mouseleave', 'touchend', 'touchcancel'].forEach(function (name) {
      el('pttBtn').addEventListener(name, pttUp);
    });

    el('pttCheck').addEventListener('change', function (event) {
      state.ptt = event.target.checked;
      if (!state.ptt) {
        setSending(true);
        micMessage.textContent = 'Push to talk off: audio is sent continuously.';
      } else {
        state.sending = false;
        setSending(false);
        micMessage.textContent = 'Push to talk on: hold the button or the space bar.';
      }
    });

    window.addEventListener('keydown', function (event) {
      if (event.code === 'Space' && state.ctx && state.ptt && !event.repeat) {
        event.preventDefault();
        pttDown();
      }
    });
    window.addEventListener('keyup', function (event) {
      if (event.code === 'Space') pttUp();
    });

    el('startBtn').addEventListener('click', start);
    el('stopBtn').addEventListener('click', function () { stop(false); });
    el('refreshDevices').addEventListener('click', function () { refreshDevices(); micMessage.textContent = 'Device list refreshed.'; });
    el('deviceSelect').addEventListener('change', function (event) {
      state.deviceId = event.target.value;
      if (state.ctx) {
        stop(true);
        micMessage.textContent = 'Device changed. Press Start Mic to reconnect.';
      }
    });

    el('inputGain').addEventListener('input', function (event) {
      state.gain = Number(event.target.value);
      el('inputGainDisplay').textContent = state.gain.toFixed(1) + 'x';
      if (state.ctx && state.monitorGain) state.monitorGain.gain.value = state.monitorOn ? 0.9 * Math.min(2, state.gain) : 0;
    });

    el('monitorCheck').addEventListener('change', function (event) {
      state.monitorOn = event.target.checked;
      if (state.ctx && state.monitorGain) {
        state.monitorGain.gain.value = state.monitorOn ? 0.9 : 0;
      }
    });

    var saveLoudness = function (overrides) {
      return post('/audio/loudness', overrides).then(function (payload) {
        var loudness = (payload && payload.settings && payload.settings.loudness) || {};
        el('micGainDisplay').textContent = Number(loudness.micGain).toFixed(1) + 'x';
        el('duckDisplay').textContent = Number(loudness.duckLevel).toFixed(2);
      });
    };

    el('micGain').addEventListener('input', function (event) {
      el('micGainDisplay').textContent = Number(event.target.value).toFixed(1) + 'x';
      saveLoudness({ micGain: Number(event.target.value) });
    });
    el('duckCheck').addEventListener('change', function (event) { saveLoudness({ duckMusic: event.target.checked }); });
    el('duckLevel').addEventListener('input', function (event) {
      el('duckDisplay').textContent = Number(event.target.value).toFixed(2);
      saveLoudness({ duckLevel: Number(event.target.value) });
    });

    el('forceStop').addEventListener('click', function () {
      post('/mic/stop').then(function (payload) {
        routingMessage.textContent = (payload && payload.status) || 'Server disconnected the mic.';
      });
    });

    var renderRouting = function (bots, routing) {
      var rows = el('routingRows');
      var routes = (routing && routing.bots) || {};
      el('defaultRoute').value = (routing && routing.default) || 'mix';

      if (!bots.length) {
        rows.innerHTML = '<tr><td colspan="3" class="hint">No accounts loaded from the token file yet.</td></tr>';
        return;
      }

      rows.innerHTML = bots.map(function (bot) {
        var selected = routes[String(bot.index - 1)] || (routing && routing.default) || 'mix';
        return '<tr>'
          + '<td><strong>Account ' + bot.index + '</strong><div class="hint mono">' + (bot.tag || bot.masked || '') + '</div></td>'
          + '<td class="' + (bot.ready ? 'status-ready' : 'status-offline') + '">' + (bot.ready ? 'Ready' : 'Offline') + '</td>'
          + '<td><select data-route-index="' + (bot.index - 1) + '">'
          + ['mix', 'music', 'mic', 'off'].map(function (mode) {
            return '<option value="' + mode + '"' + (mode === selected ? ' selected' : '') + '>' + mode + '</option>';
          }).join('')
          + '</select></td>'
          + '</tr>';
      }).join('');

      Array.prototype.forEach.call(document.querySelectorAll('[data-route-index]'), function (select) {
        select.addEventListener('change', function (event) {
          var bots2 = {};
          bots2[event.target.dataset.routeIndex] = event.target.value;
          post('/mic/routing', { bots: bots2 }).then(function (payload) {
            routingMessage.textContent = (payload && payload.status) || 'Routing updated.';
            return refresh();
          });
        });
      });
    };

    el('defaultRoute').addEventListener('change', function (event) {
      post('/mic/routing', { default: event.target.value }).then(function (payload) {
        routingMessage.textContent = (payload && payload.status) || 'Default route updated.';
        return refresh();
      });
    });

    var refresh = function () {
      return Promise.all([
        fetch('/settings').then(function (res) { return res.json(); }),
        fetch('/status').then(function (res) { return res.json(); })
      ]).then(function (results) {
        var settings = results[0] || {};
        var status = results[1] || {};
        var loudness = settings.loudness || {};
        el('micGain').value = loudness.micGain;
        el('micGainDisplay').textContent = Number(loudness.micGain).toFixed(1) + 'x';
        el('duckCheck').checked = loudness.duckMusic !== false;
        el('duckLevel').value = loudness.duckLevel;
        el('duckDisplay').textContent = Number(loudness.duckLevel).toFixed(2);
        renderRouting(status.bots || [], (settings.mic && settings.mic.routing) || {});
      }).catch(function () {});
    };

    var pollMic = function () {
      fetch('/mic/status').then(function (res) { return res.json(); }).then(function (info) {
        var live = info && info.active;
        el('serverState').textContent = (live ? 'receiving' : 'waiting') + ' · ' + (info.clients || 0) + ' client(s) · ' + (info.packets || 0) + ' packets';
      }).catch(function () {
        el('serverState').textContent = 'unreachable';
      });
    };

    drawMeter();
    refreshDevices();
    refresh();
    pollMic();
    setInterval(pollMic, 2000);
    setInterval(refresh, 10000);
  </script>
</body>
</html>`;
}

module.exports = { renderMicRoutePage };
