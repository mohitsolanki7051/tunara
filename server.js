const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');
const app = express();

app.use(express.json());

const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

const tunnels = new Map();
const tokens = new Map();

const STORAGE_FILE = '/tmp/tunnels.json';
const LARAVEL_URL = process.env.LARAVEL_URL || 'https://tunara-web.up.railway.app';

function loadTunnels() {
    try {
        if (fs.existsSync(STORAGE_FILE)) {
            const data = JSON.parse(fs.readFileSync(STORAGE_FILE, 'utf8'));
            Object.entries(data).forEach(([id, info]) => {
                tunnels.set(id, {
                    localUrl: info.localUrl,
                    senderSocketId: null,
                    isOnline: false,
                    isProtected: info.isProtected || false,
                    createdAt: info.createdAt
                });
            });
            console.log(`Loaded ${tunnels.size} tunnels from storage`);
        }
    } catch(e) {
        console.log('Could not load tunnels:', e.message);
    }
}

function saveTunnels() {
    try {
        const data = {};
        for (const [id, info] of tunnels) {
            data[id] = {
                localUrl: info.localUrl,
                isProtected: info.isProtected || false,
                createdAt: info.createdAt
            };
        }
        fs.writeFileSync(STORAGE_FILE, JSON.stringify(data));
    } catch(e) {
        console.log('Could not save tunnels:', e.message);
    }
}

loadTunnels();

// ============ API ROUTES ============

app.post('/api/tunnel/register', (req, res) => {
    const { localUrl, isProtected } = req.body;
    const tunnelId = Math.random().toString(36).substring(2, 10);
    const publicUrl = `${req.protocol}://${req.get('host')}/t/${tunnelId}`;

    tunnels.set(tunnelId, {
        localUrl,
        senderSocketId: null,
        isOnline: false,
        isProtected: isProtected || false,
        createdAt: Date.now()
    });

    saveTunnels();
    console.log(`Tunnel registered: ${tunnelId} -> ${localUrl} (protected: ${isProtected || false})`);
    res.json({ success: true, tunnelId, publicUrl });
});

app.post('/api/token/store', (req, res) => {
    const { token, userId } = req.body;
    if (!token || !userId) {
        return res.status(400).json({ success: false, message: 'Token and userId required.' });
    }
    tokens.set(token, userId);
    console.log(`Token stored for user: ${userId}`);
    res.json({ success: true });
});

app.get('/api/tunnel/status/:tunnelId', (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    const tunnel = tunnels.get(req.params.tunnelId);
    if (!tunnel) return res.json({ isOnline: false });
    res.json({ isOnline: tunnel.isOnline, isProtected: tunnel.isProtected || false });
});

app.get('/', (req, res) => {
    res.send(`<h1>Tunnel Server</h1><p>Active tunnels: ${tunnels.size}</p>`);
});

app.get('/t/:tunnelId/:assetPath(*)', async (req, res) => {
    const { tunnelId } = req.params;
    const assetPath = '/' + req.params[0];

    const tunnel = tunnels.get(tunnelId);
    if (!tunnel || !tunnel.isOnline) {
        return res.status(404).send('Asset not available');
    }

    const requestId = Date.now() + '-' + Math.random();

    const timeout = setTimeout(() => {
        res.status(504).send('Asset timeout');
    }, 10000);

    io.to(tunnel.senderSocketId).emit('request-asset', {
        requestId,
        path: assetPath,
    });

    io.once(`asset-response-${requestId}`, (data) => {
        clearTimeout(timeout);
        if (data.error) return res.status(404).send('Asset not found');
        const buf = Buffer.from(data.data, 'base64');
        res.setHeader('Content-Type', data.contentType || 'application/octet-stream');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.send(buf);
    });
});
// ============ VIEWER PAGE ============

app.get('/t/:tunnelId', (req, res) => {
    const { tunnelId } = req.params;
    const tunnel = tunnels.get(tunnelId);
    if (!tunnel) return res.status(404).send(`
        <!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;background:#0f0f0f;color:#fff">
        <h2 style="color:#f87171">Tunnel Not Found</h2>
        <p style="color:#888;margin-top:8px">Tunnel ID <b>${tunnelId}</b> does not exist.</p>
        <p style="color:#555;margin-top:8px">Register a tunnel and start the Tunara desktop app.</p>
        </body></html>
    `);

    const viewerHtml = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Tunnel - ${tunnelId}</title>
    <script src="/socket.io/socket.io.js"></script>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: system-ui, sans-serif; background: #f5f5f5; }
        .banner {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 0 16px;
            font-size: 13px;
            position: fixed;
            top: 0; left: 0; right: 0;
            z-index: 999999;
            display: flex;
            align-items: center;
            gap: 10px;
            height: 44px;
        }
        .dot { width: 8px; height: 8px; border-radius: 50%; background: #4ade80; flex-shrink: 0; }
        .dot.off { background: #f87171; }
        .banner-status { font-weight: 600; }
        .banner-nav { display: flex; align-items: center; gap: 6px; margin-left: auto; }
        .nav-btn {
            background: rgba(255,255,255,0.15);
            border: none;
            color: white;
            width: 28px; height: 28px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            display: flex; align-items: center; justify-content: center;
            transition: background 0.15s;
        }
        .nav-btn:hover:not(:disabled) { background: rgba(255,255,255,0.25); }
        .nav-btn:disabled { opacity: 0.35; cursor: not-allowed; }
        .nav-btn svg { width: 14px; height: 14px; }
        .home-btn {
            background: rgba(255,255,255,0.15);
            border: none;
            color: white;
            height: 28px;
            padding: 0 12px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 12px;
            font-weight: 500;
            transition: background 0.15s;
            display: flex; align-items: center; gap: 5px;
        }
        .home-btn:hover { background: rgba(255,255,255,0.25); }
        .banner-id { opacity: 0.6; font-size: 11px; margin-left: 4px; }

        #frame-wrapper { position: fixed; top: 44px; left: 0; right: 0; bottom: 0; display: none; }
        iframe { width: 100%; height: 100%; border: none; background: white; }
        .loading {
            position: fixed; top: 44px; left: 0; right: 0; bottom: 0;
            display: flex; align-items: center; justify-content: center;
            flex-direction: column; gap: 16px; background: #f9fafb; color: #6b7280;
        }
        .spinner {
            width: 36px; height: 36px;
            border: 3px solid #e5e7eb; border-top-color: #667eea;
            border-radius: 50%; animation: spin 0.8s linear infinite;
        }
        .loading-text { font-size: 14px; text-align: center; }
        @keyframes spin { to { transform: rotate(360deg); } }

        /* Password form */
        .pw-input {
            background: #1a1a2e;
            border: 1px solid #333;
            border-radius: 8px;
            padding: 10px 14px;
            color: #fff;
            font-size: 14px;
            width: 200px;
            outline: none;
            font-family: system-ui, sans-serif;
        }
        .pw-input:focus { border-color: #667eea; }
        .pw-btn {
            background: linear-gradient(135deg, #667eea, #764ba2);
            border: none;
            border-radius: 8px;
            padding: 10px 18px;
            color: #fff;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            font-family: system-ui, sans-serif;
        }
        .pw-btn:hover { opacity: 0.9; }
        .pw-error { font-size: 12px; color: #f87171; margin-top: 10px; display: none; }
    </style>
</head>
<body>
<div class="banner">
    <div class="banner-nav">
        <button class="nav-btn" id="btn-back" disabled title="Back">
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M15 19l-7-7 7-7"/></svg>
        </button>
        <button class="nav-btn" id="btn-forward" disabled title="Forward">
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 5l7 7-7 7"/></svg>
        </button>
        <button class="home-btn" id="btn-home" title="Home">
            <svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"/></svg>
            Home
        </button>
    </div>

    <span class="dot" id="dot"></span>
    <span>Tunnel &nbsp;|&nbsp; <span class="banner-status" id="status">Connecting...</span></span>
    <span class="banner-id" style="margin-left:auto">ID: ${tunnelId}</span>
</div>

<div class="loading" id="loading">
    <div class="spinner" id="spinner"></div>
    <div class="loading-text" id="loading-text">Connecting...</div>
</div>

<div id="frame-wrapper">
    <iframe id="frame" sandbox="allow-scripts allow-forms allow-popups allow-modals allow-same-origin"></iframe>
</div>

<script>
(function() {
    var TUNNEL_ID = '${tunnelId}';
    var socket = io({ transports: ['websocket', 'polling'] });
    var sessionCookies = '';
    var csrfToken = '';
    var currentPath = '/';
    var localUrl = '';
    var isPasswordVerified = false;

    // Navigation history
    var navHistory = ['/'];
    var historyIndex = 0;

    function updateNavBtns() {
        document.getElementById('btn-back').disabled = historyIndex <= 0;
        document.getElementById('btn-forward').disabled = historyIndex >= navHistory.length - 1;
    }

    document.getElementById('btn-back').addEventListener('click', function() {
        if (historyIndex <= 0) return;
        historyIndex--;
        currentPath = navHistory[historyIndex];
        showLoading('Loading...');
        socket.emit('viewer-join', { tunnelId: TUNNEL_ID, path: currentPath });
        updateNavBtns();
    });

    document.getElementById('btn-forward').addEventListener('click', function() {
        if (historyIndex >= navHistory.length - 1) return;
        historyIndex++;
        currentPath = navHistory[historyIndex];
        showLoading('Loading...');
        socket.emit('viewer-join', { tunnelId: TUNNEL_ID, path: currentPath });
        updateNavBtns();
    });

    document.getElementById('btn-home').addEventListener('click', function() {
        navigateTo('/');
    });

    socket.on('connect', function() {
        setStatus('Online', false);
        setText('Loading your project...');
        socket.emit('viewer-join', { tunnelId: TUNNEL_ID, path: currentPath });
    });

    socket.on('disconnect', function() {
        setStatus('Disconnected', true);
    });

    socket.on('host-offline', function() {
        setStatus('Host Offline', true);
        document.getElementById('spinner').style.display = 'none';
        setText('Host is offline. Please start the Tunara desktop app.');
    });

    socket.on('host-online', function() {
        setStatus('Online', false);
        document.getElementById('spinner').style.display = 'block';
        socket.emit('viewer-join', { tunnelId: TUNNEL_ID, path: currentPath });
    });

    socket.on('tunnel-info', function(data) {
        if (data.localUrl) localUrl = data.localUrl;
    });

    // Password required
    socket.on('password-required', function() {
        setStatus('🔒 Protected', true);
        document.getElementById('spinner').style.display = 'none';
        document.getElementById('loading-text').innerHTML =
            '<div style="text-align:center;">' +
            '<div style="font-size:36px;margin-bottom:16px;">🔒</div>' +
            '<p style="font-size:16px;font-weight:600;margin-bottom:6px;color:#1f2937;">Password Protected</p>' +
            '<p style="font-size:13px;color:#9ca3af;margin-bottom:20px;">Enter the password to access this tunnel.</p>' +
            '<div style="display:flex;gap:8px;justify-content:center;">' +
            '<input type="password" id="tunnel-password" class="pw-input" placeholder="Enter password">' +
            '<button class="pw-btn" id="pw-submit-btn">Unlock</button>' +
            '</div>' +
            '<p class="pw-error" id="pw-error">Wrong password. Try again.</p>' +
            '</div>';

        document.getElementById('pw-submit-btn').addEventListener('click', submitPassword);
        document.getElementById('tunnel-password').addEventListener('keydown', function(e) {
            if (e.key === 'Enter') submitPassword();
        });
        setTimeout(function() {
            var input = document.getElementById('tunnel-password');
            if (input) input.focus();
        }, 100);
    });

    // Password wrong
    socket.on('password-wrong', function() {
        var err = document.getElementById('pw-error');
        if (err) err.style.display = 'block';
        var input = document.getElementById('tunnel-password');
        if (input) { input.value = ''; input.focus(); }
    });

    // Request limit reached
    socket.on('request-limited', function(data) {
        setStatus('Limit Reached', true);
        document.getElementById('spinner').style.display = 'none';
        document.getElementById('loading-text').innerHTML =
            '<div style="text-align:center;">' +
            '<div style="font-size:36px;margin-bottom:16px;">⚠️</div>' +
            '<p style="font-size:16px;font-weight:600;margin-bottom:6px;color:#1f2937;">Request Limit Reached</p>' +
            '<p style="font-size:13px;color:#9ca3af;">This tunnel has reached its daily request limit. Please try again tomorrow or ask the owner to upgrade to Pro.</p>' +
            '</div>';
    });

    function submitPassword() {
        var pw = document.getElementById('tunnel-password');
        if (!pw || !pw.value.trim()) return;
        var err = document.getElementById('pw-error');
        if (err) err.style.display = 'none';
        socket.emit('viewer-join', { tunnelId: TUNNEL_ID, path: currentPath, password: pw.value.trim() });
    }

    socket.on('page-content', function(data) {
        if (data.cookies) sessionCookies = data.cookies;
        if (data.csrfToken) csrfToken = data.csrfToken;
        if (data.currentPath) currentPath = data.currentPath;
        if (data.localUrl) localUrl = data.localUrl;
        if (!data.html) return;
        renderPage(data.html, localUrl, data.currentPath || currentPath);
    });

    socket.on('redirect', function(data) {
        navigateTo(data.url);
    });

    function navigateTo(url) {
        var path = url;
        try { var u = new URL(url); path = u.pathname + u.search + u.hash; } catch(e) {}

        if (path !== currentPath) {
            navHistory = navHistory.slice(0, historyIndex + 1);
            navHistory.push(path);
            historyIndex = navHistory.length - 1;
            updateNavBtns();
        }

        currentPath = path;
        showLoading('Loading...');
        socket.emit('viewer-join', { tunnelId: TUNNEL_ID, path: path });
    }

    function submitForm(method, action, body) {
        var path = action;
        try { var u = new URL(action); path = u.pathname + u.search; } catch(e) {}
        showLoading('Submitting...');
        socket.emit('forward-request', {
            method: method,
            url: path,
            body: body,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-CSRF-TOKEN': csrfToken,
                'Cookie': sessionCookies
            },
            viewerSocketId: socket.id
        });
    }

    function renderPage(html, base, path) {
        var frame = document.getElementById('frame');
        var safeBase = base || 'http://127.0.0.1:8000';
        var processed = html.replace(/<base[^>]*>/gi, '');

        var inject = '<base href="' + safeBase + '/">'
            + '<script>(function(){'
            + 'function p(m){window.parent.postMessage(m,"*");}'
            + 'document.addEventListener("click",function(e){'
            +   'var a=e.target.closest("a");if(!a)return;'
            +   'var h=a.getAttribute("href");'
            +   'if(!h||h=="#"||h.startsWith("javascript")||h.startsWith("mailto"))return;'
            +   'e.preventDefault();e.stopPropagation();p({type:"navigate",url:a.href});'
            + '},true);'
            + 'document.addEventListener("submit",function(e){'
            +   'e.preventDefault();e.stopPropagation();'
            +   'var f=e.target;'
            +   'var m=(f.getAttribute("method")||"POST").toUpperCase();'
            +   'var a=f.action||window.location.href;'
            +   'var fd=new FormData(f);'
            +   'var fm=m;if(fd.has("_method"))fm=fd.get("_method").toUpperCase();'
            +   'p({type:"submit",method:fm,action:a,body:new URLSearchParams(fd).toString()});'
            + '},true);'
            + '})()<' + '/script>';

        if (processed.indexOf('<head>') !== -1) {
            processed = processed.replace('<head>', '<head>' + inject);
        } else if (processed.indexOf('</head>') !== -1) {
            processed = processed.replace('</head>', inject + '</head>');
        } else {
            processed = inject + processed;
        }

        var blob = new Blob([processed], { type: 'text/html; charset=utf-8' });
        var blobUrl = URL.createObjectURL(blob);
        frame.onload = function() {
            URL.revokeObjectURL(blobUrl);
            document.getElementById('loading').style.display = 'none';
            document.getElementById('frame-wrapper').style.display = 'block';
        };
        frame.src = blobUrl;
    }

    window.addEventListener('message', function(e) {
        var msg = e.data;
        if (!msg || !msg.type) return;
        if (msg.type === 'navigate') { navigateTo(msg.url); }
        else if (msg.type === 'submit') { submitForm(msg.method, msg.action, msg.body); }
    });

    function setStatus(text, isOff) {
        document.getElementById('status').textContent = text;
        var dot = document.getElementById('dot');
        if (isOff) dot.classList.add('off'); else dot.classList.remove('off');
    }
    function showLoading(text) {
        document.getElementById('loading').style.display = 'flex';
        document.getElementById('frame-wrapper').style.display = 'none';
        document.getElementById('spinner').style.display = 'block';
        setText(text || 'Loading...');
    }
    function setText(t) { document.getElementById('loading-text').textContent = t; }

    showLoading('Connecting...');
    updateNavBtns();
})();
</script>
</body>
</html>`;

    res.send(viewerHtml);
});

// ============ WEBSOCKET ============

io.on('connection', (socket) => {
    console.log('Connected:', socket.id);

    socket.on('sender-connect', ({ tunnelId, localUrl, token }) => {
        const tunnel = tunnels.get(tunnelId);
        if (!tunnel) {
            console.log('Unknown tunnel:', tunnelId);
            socket.emit('auth-error', { message: 'Tunnel not found.' });
            return;
        }

        if (token && !tokens.has(token)) {
            console.log('Invalid token for tunnel:', tunnelId);
            socket.emit('auth-error', { message: 'Invalid token.' });
            return;
        }

        tunnel.senderSocketId = socket.id;
        tunnel.isOnline = true;
        tunnel.localUrl = localUrl;
        console.log(`Sender online: ${tunnelId} (protected: ${tunnel.isProtected})`);
        socket.emit('sender-confirm', { status: 'online' });
        io.to(tunnelId).emit('host-online');
    });

socket.on('viewer-join', async ({ tunnelId, path, password }) => {
    const tunnel = tunnels.get(tunnelId);
    if (!tunnel) return;
    if (!tunnel.isOnline) { socket.emit('host-offline'); return; }

    // ── 1. Password check (sirf pehli baar, already verified ho toh skip) ──
    if (tunnel.isProtected && !socket.passwordVerified) {
        if (!password) {
            socket.emit('password-required');
            return;
        }
        try {
            const res = await fetch(`${LARAVEL_URL}/api/tunnel/verify-password`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tunnel_id: tunnelId, password })
            });
            const data = await res.json();
            if (!data.valid) {
                socket.emit('password-wrong');
                return;
            }
            socket.passwordVerified = true;
        } catch(e) {
            console.log('Password check failed, allowing:', e.message);
        }
    }

    // ── 2. Request limit check ──
    try {
        const limitRes = await fetch(`${LARAVEL_URL}/api/request/check/${tunnelId}`);
        const limitData = await limitRes.json();
        if (limitData.limited) {
            socket.emit('request-limited', { message: 'Daily request limit reached.' });
            return;
        }
    } catch(e) {
        console.log('Limit check failed, allowing:', e.message);
    }

    // ── 3. Request log (async, non-blocking) ──
    fetch(`${LARAVEL_URL}/api/request/log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tunnel_id: tunnelId, path: path || '/', method: 'GET' })
    }).catch(e => console.log('Log failed:', e.message));

    // ── 4. Forward request to sender ──
    socket.join(tunnelId);
    socket.emit('tunnel-info', { localUrl: tunnel.localUrl });
    io.to(tunnel.senderSocketId).emit('request-page', {
        requestId: Date.now() + '-' + Math.random(),
        path: path || '/',
        viewerSocketId: socket.id
    });
});

    socket.on('forward-request', (data) => {
        const { method, url, body, headers, viewerSocketId } = data;
        let targetTunnel = null;
        for (const [tid, tunnel] of tunnels) {
            if (!tunnel.isOnline) continue;
            const room = io.sockets.adapter.rooms.get(tid);
            if (room && room.has(viewerSocketId)) { targetTunnel = tunnel; break; }
        }
        if (targetTunnel) {
            io.to(targetTunnel.senderSocketId).emit('forward-request', {
                requestId: Date.now() + '-' + Math.random(),
                method, url, body, headers, viewerSocketId
            });
        }
    });

    socket.on('page-response', ({ html, viewerSocketId, cookies, csrfToken, currentPath, redirectUrl }) => {
        if (redirectUrl) {
            io.to(viewerSocketId).emit('redirect', { url: redirectUrl });
        } else {
            io.to(viewerSocketId).emit('page-content', { html, cookies, csrfToken, currentPath });
        }
    });

    socket.on('request-response', ({ html, viewerSocketId, redirectUrl, cookies, csrfToken, currentPath }) => {
        if (redirectUrl) {
            io.to(viewerSocketId).emit('redirect', { url: redirectUrl });
        } else {
            io.to(viewerSocketId).emit('page-content', { html, cookies, csrfToken, currentPath });
        }
    });

    socket.on('keep-alive', () => socket.emit('keep-alive'));

    socket.on('disconnect', () => {
        for (const [tunnelId, tunnel] of tunnels) {
            if (tunnel.senderSocketId === socket.id) {
                tunnel.isOnline = false;
                tunnel.senderSocketId = null;
                console.log(`Sender offline: ${tunnelId}`);
                io.to(tunnelId).emit('host-offline');
                break;
            }
        }
        console.log('Disconnected:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Tunnel Server running on port ${PORT}`);
});
