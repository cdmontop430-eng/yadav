const { BASE_STYLES } = require('./styles');

// Text file page: view and edit tokens.txt, or paste one token / a whole list.
function renderTokenFilePage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Token File · Veera.exe</title>
  <style>${BASE_STYLES}
    textarea {
      width:100%; min-height:220px; border:1px solid #334155; border-radius:12px; padding:12px 14px;
      background:#0f172a; color:#e2e8f0; font-family:ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size:13px; line-height:1.6; resize:vertical; white-space:pre; overflow-wrap:normal; overflow-x:auto;
    }
    textarea.short { min-height:120px; }
    input[type="text"] { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; }
  </style>
</head>
<body>
  <h1>Token File</h1>
  <p><span class="mono" id="filePath">loading…</span> is where your tokens live: one token per line. Edit it here, paste a single token, or paste a whole list at once. Saving writes the file and the server logs accounts in or out immediately.</p>

  <div class="nav">
    <a href="/">Dashboard</a>
    <a href="/token-file">Token File</a>
    <a href="/mic-route">Mic Routing</a>
  </div>

  <div class="card">
    <h2>Status</h2>
    <div class="kv"><span>File</span><span class="mono" id="path">-</span></div>
    <div class="kv"><span>Tokens in file</span><span id="count">-</span></div>
    <div class="kv"><span>Last sync</span><span id="lastSync">-</span></div>
    <div class="actions">
      <button id="reloadBtn" style="background:#475569;color:#fff;">Reload from disk</button>
      <button id="refreshBtn" style="background:#475569;color:#fff;">Refresh</button>
    </div>
    <div id="statusMessage" class="msg"></div>
  </div>

  <div class="card">
    <h2>Add tokens</h2>
    <div class="form-row">
      <input type="text" id="singleInput" placeholder="Paste one token" />
    </div>
    <div class="actions">
      <button id="addSingleBtn" style="background:#22c55e;color:#0f172a;">Add token</button>
    </div>
    <div class="form-row" style="margin-top:20px;">
      <textarea id="bulkInput" class="short" placeholder="Paste as many as you like, one per line (commas or spaces also work)"></textarea>
    </div>
    <div class="actions">
      <button id="addBulkBtn" style="background:#8b5cf6;color:#fff;">Add all of them</button>
    </div>
    <div id="addMessage" class="msg"></div>
  </div>

  <div class="card">
    <h2>Edit the file</h2>
    <div class="form-row">
      <textarea id="fileText" spellcheck="false" placeholder="one token per line"></textarea>
    </div>
    <div class="actions">
      <button id="saveBtn" style="background:#22c55e;color:#0f172a;">Save file</button>
      <button id="revertBtn" style="background:#475569;color:#fff;">Discard changes</button>
    </div>
    <div class="hint" style="margin-top:10px;">Ctrl+S saves. Blank lines and lines starting with # are ignored, duplicates are dropped.</div>
    <div id="saveMessage" class="msg"></div>
  </div>

  <div class="card">
    <h2>Accounts</h2>
    <div id="tokenList" style="display:grid; gap:10px;"></div>
  </div>

  <script>
    var el = function (id) { return document.getElementById(id); };
    var statusMessage = el('statusMessage');
    var addMessage = el('addMessage');
    var saveMessage = el('saveMessage');

    // Optional: set TOKEN_FILE_KEY and the file endpoints require it.
    var apiKey = sessionStorage.getItem('veera.tokenKey') || '';
    var headers = function () {
      return apiKey ? { 'Content-Type': 'application/json', 'x-token-key': apiKey } : { 'Content-Type': 'application/json' };
    };

    var post = function (url, body) {
      return fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(body || {}) })
        .then(function (res) { return res.json().then(function (payload) { return { status: res.status, body: payload }; }); });
    };

    var unauthorized = function (response) {
      var key = window.prompt('This token file is protected. Enter TOKEN_FILE_KEY:');
      if (!key) return false;
      apiKey = key;
      sessionStorage.setItem('veera.tokenKey', key);
      statusMessage.textContent = 'Key saved for this tab.';
      return response !== 401;
    };

    var loadFile = function () {
      return fetch('/api/tokens/file', { headers: headers() })
        .then(function (res) {
          if (res.status === 401) {
            if (!unauthorized(res)) return null;
            return loadFile();
          }
          return res.json();
        })
        .then(function (payload) {
          if (!payload) return;
          el('fileText').value = payload.content;
          renderStatus(payload.tokenFile);
        })
        .catch(function (error) { statusMessage.textContent = 'Error: ' + error.message; });
    };

    var renderStatus = function (file) {
      if (!file) return;
      el('path').textContent = file.path;
      el('filePath').textContent = file.path;
      el('count').textContent = String(file.count);
      el('lastSync').textContent = file.lastSyncAt
        ? new Date(file.lastSyncAt).toLocaleTimeString() + ' (' + (file.lastTrigger || 'manual') + ')'
        : 'never';
    };

    var refreshStatus = function () {
      return fetch('/settings').then(function (res) { return res.json(); })
        .then(function (settings) { renderStatus(settings.tokenFile); })
        .catch(function () {});
    };

    var renderList = function (data) {
      var list = (data && data.tokens) || [];
      var target = el('tokenList');
      if (!list.length) {
        target.innerHTML = '<div class="hint">No tokens yet. Paste one above.</div>';
        return;
      }

      target.innerHTML = list.map(function (item) {
        var status = item.status || 'waiting';
        var label = status === 'ready' ? 'Ready' : status === 'invalid' ? 'Invalid' : status === 'offline' ? 'Offline' : 'Waiting';
        var color = status === 'ready' ? '#22c55e' : status === 'invalid' ? '#f97316' : status === 'offline' ? '#fbbf24' : '#38bdf8';
        var errorText = item.lastError ? '<div class="hint danger">' + item.lastError + '</div>' : '';
        return '<div style="padding:12px;border:1px solid rgba(148,163,184,.22);border-radius:12px;background:#0f172a;display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap;">'
          + '<div style="flex:1;min-width:220px;">'
          + '<div><strong>Account ' + (item.index + 1) + '</strong> <span style="color:' + color + ';font-weight:700;">' + label + '</span></div>'
          + '<div class="hint mono">' + (item.masked || 'hidden') + '</div>'
          + errorText
          + '</div>'
          + '<button type="button" data-remove="' + item.index + '" class="remove-btn" style="background:#ef4444;color:#fff;padding:8px 12px;border-radius:10px;border:none;cursor:pointer;font-weight:700;">Remove</button>'
          + '</div>';
      }).join('');

      Array.prototype.forEach.call(document.querySelectorAll('[data-remove]'), function (button) {
        button.addEventListener('click', function () {
          post('/tokens/delete', { index: Number(button.dataset.remove) }).then(function (response) {
            statusMessage.textContent = (response.body && (response.body.status || response.body.error)) || 'Removed.';
            return Promise.all([loadFile(), fetch('/tokens').then(function (res) { return res.json(); }).then(renderList)]);
          });
        });
      });
    };

    var refreshList = function () {
      return fetch('/tokens').then(function (res) { return res.json(); }).then(renderList).catch(function () {});
    };

    el('addSingleBtn').addEventListener('click', function () {
      var value = el('singleInput').value.trim();
      if (!value) {
        addMessage.textContent = 'Paste a token first.';
        return;
      }
      addMessage.textContent = 'Adding...';
      post('/api/tokens/append', { tokens: value }).then(function (response) {
        var body = response.body || {};
        addMessage.textContent = body.status || body.error || 'Done';
        el('singleInput').value = '';
        return Promise.all([loadFile(), refreshList()]);
      });
    });

    el('addBulkBtn').addEventListener('click', function () {
      var value = el('bulkInput').value.trim();
      if (!value) {
        addMessage.textContent = 'Paste some tokens first.';
        return;
      }
      addMessage.textContent = 'Adding in bulk...';
      post('/api/tokens/append', { tokens: value }).then(function (response) {
        var body = response.body || {};
        addMessage.textContent = body.status || body.error || 'Done';
        el('bulkInput').value = '';
        return Promise.all([loadFile(), refreshList()]);
      });
    });

    var saveFile = function () {
      saveMessage.textContent = 'Saving...';
      return post('/api/tokens/save', { content: el('fileText').value }).then(function (response) {
        var body = response.body || {};
        saveMessage.textContent = body.status || body.error || 'Saved';
        return Promise.all([loadFile(), refreshList()]);
      });
    };

    el('saveBtn').addEventListener('click', saveFile);

    el('revertBtn').addEventListener('click', function () {
      saveMessage.textContent = 'Reloaded from disk.';
      loadFile();
    });

    el('fileText').addEventListener('keydown', function (event) {
      if ((event.ctrlKey || event.metaKey) && event.key === 's') {
        event.preventDefault();
        saveFile();
      }
    });

    el('reloadBtn').addEventListener('click', function () {
      statusMessage.textContent = 'Reloading from disk...';
      post('/tokens/reload').then(function (response) {
        statusMessage.textContent = (response.body && (response.body.status || response.body.error)) || 'Reloaded';
        return Promise.all([loadFile(), refreshList()]);
      });
    });

    el('refreshBtn').addEventListener('click', function () {
      Promise.all([loadFile(), refreshList()]);
    });

    loadFile();
    refreshList();
    setInterval(function () { refreshStatus(); refreshList(); }, 10000);
  </script>
</body>
</html>`;
}

module.exports = { renderTokenFilePage };
