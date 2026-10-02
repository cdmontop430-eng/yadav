const BASE_STYLES = `
    * { box-sizing: border-box; }
    body { background:#0b1220; color:#e5e7eb; font-family:system-ui, -apple-system, "Segoe UI", sans-serif; margin:0; padding:24px; }
    textarea {
      width:100%; min-height:120px; border:1px solid #334155; border-radius:12px; padding:12px 14px;
      background:#0f172a; color:#e2e8f0; font-family:ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size:13px; line-height:1.6; resize:vertical;
    }
    h1 { margin:0 0 8px; font-size:clamp(1.8rem, 3vw, 2.6rem); }
    h2 { margin-top:0; font-size:1.25rem; }
    p { margin:4px 0 16px; color:#9ca3af; line-height:1.5; }
    a { color:#38bdf8; text-decoration:none; }
    a:hover { text-decoration:underline; }
    code, .mono { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; }
    input, button, select { font:inherit; }
    input[type="text"], input[type="number"], input:not([type]), select {
      width:100%; max-width:420px; border:1px solid #334155; border-radius:12px; padding:12px 14px;
      background:#0f172a; color:#e2e8f0;
    }
    select { cursor:pointer; }
    input[type="range"] { width:100%; accent-color:#f43f5e; cursor:pointer; }
    input[type="checkbox"] { width:18px; height:18px; accent-color:#f43f5e; cursor:pointer; }
    input[type="file"] { background:#1e293b; border-color:#475569; }
    button { cursor:pointer; border:none; padding:14px 18px; border-radius:14px; font-weight:700; letter-spacing:.02em; }
    button:disabled { opacity:.5; cursor:not-allowed; }
    .card { background:rgba(15, 23, 42, .95); border:1px solid rgba(148,163,184,.15); border-radius:18px; padding:18px; width:100%; max-width:920px; margin-bottom:20px; }
    .form-row { display:grid; gap:12px; margin-bottom:16px; }
    .actions { display:flex; flex-wrap:wrap; gap:10px; margin-top:16px; }
    .actions button { flex:1 1 160px; }
    .row { display:flex; flex-wrap:wrap; gap:12px; margin-bottom:16px; }
    .control { margin-bottom:16px; }
    .control > label { display:flex; justify-content:space-between; gap:12px; margin-bottom:8px; font-weight:700; color:#f43f5e; }
    .control.check { display:flex; align-items:center; gap:10px; color:#cbd5e1; font-weight:600; }
    .control.check label { color:#cbd5e1; font-weight:600; }
    .hint { font-size:12px; color:#94a3b8; margin-top:6px; line-height:1.5; }
    .msg { margin:18px 0 0; color:#cbd5e1; min-height:1.2em; }
    .pill { display:inline-block; padding:3px 10px; border-radius:999px; font-size:12px; font-weight:700; background:#1e293b; color:#cbd5e1; }
    .pill.on { background:#064e3b; color:#6ee7b7; }
    .pill.off { background:#4c1d95; color:#c4b5fd; }
    .pill.warn { background:#7c2d12; color:#fdba74; }
    .kv { display:flex; justify-content:space-between; gap:12px; font-size:13px; padding:8px 0; border-bottom:1px dashed rgba(148,163,184,.2); }
    .kv span:first-child { color:#94a3b8; }
    .nav { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:18px; }
    .nav a { padding:10px 16px; border-radius:12px; background:#1e293b; color:#e2e8f0; font-weight:700; }
    .bot { background:#111827; border:1px solid rgba(148,163,184,.12); border-radius:16px; padding:14px; margin-bottom:12px; }
    .bot span { display:inline-block; min-width:90px; color:#94a3b8; }
    .status-ready { color:#22c55e; }
    .status-offline { color:#f97316; }
    .status-vc { color:#38bdf8; }
    .muted { color:#64748b; font-size:12px; }
    .danger { color:#fecaca; }
`;

module.exports = { BASE_STYLES };
