const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const app = express();

app.use(express.json());

const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

const tunnels = new Map();

// ============ INTERCEPTOR SCRIPT (iframe ke andar inject hoga) ============
// Ye string seedha JS hai — koi template literal nesting nahi
const INTERCEPTOR_JS = `
(function() {
    function toParent(msg) {
        window.parent.postMessage(msg, '*');
    }

    // Link clicks intercept
    document.addEventListener('click', function(e) {
        var link = e.target.closest('a');
        if (!link) return;
        var href = link.getAttribute('href');
        if (!href || href === '#' || href.startsWith('javascript') || href.startsWith('mailto')) return;
        e.preventDefault();
        e.stopPropagation();
        toParent({ type: 'navigate', url: link.href });
    }, true);

    // Form submit intercept
    document.addEventListener('submit', function(e) {
        e.preventDefault();
        e.stopPropagation();
        var form = e.target;
        var method = (form.getAttribute('method') || 'POST').toUpperCase();
        var action = form.action || window.location.href;
        var formData = new FormData(form);

        // Laravel _method spoofing (PUT/DELETE/PATCH)
        var finalMethod = method;
        if (formData.has('_method')) {
            finalMethod = formData.get('_method').toUpperCase();
        }

        var body = new URLSearchParams(formData).toString();
        toParent({ type: 'submit', method: finalMethod, action: action, body: body });
    }, true);
})();
`;

// ============ HTML INJECT HELPER ============
function injectIntoHtml(html, localUrl, path) {
    if (!html || typeof html !== 'string') return '<html><body><p>Empty response</p></body></html>';

    // 1. Existing <base> hata do
    html = html.replace(/<base[^>]*>/gi, '');

    // 2. Base tag — assets (CSS/JS/images) ke liye local URL
    var baseTag = '<base href="' + localUrl + '/">';

    // 3. Interceptor script tag — safely escaped, koi nested template literal nahi
    var scriptTag = '<script>' + INTERCEPTOR_JS + '<' + '/script>';

    var metaTag = '<meta name="x-tunnel-path" content="' + (path || '/') + '">';

    var inject = baseTag + metaTag + scriptTag;

    if (html.indexOf('<head>') !== -1) {
        return html.replace('<head>', '<head>' + inject);
    } else if (html.indexOf('</head>') !== -1) {
        return html.replace('</head>', inject + '</head>');
    } else if (html.indexOf('<html>') !== -1) {
        return html.replace('<html>', '<html>' + inject);
    }
    return inject + html;
}

// ============ API ROUTES ============

app.post('/api/tunnel/register', (req, res) => {
    const { localUrl } = req.body;
    const tunnelId = Math.random().toString(36).substring(2, 10);
    const publicUrl = `http://localhost:3000/t/${tunnelId}`;
    tunnels.set(tunnelId, { localUrl, senderSocketId: null, isOnline: false, createdAt: Date.now() });
    console.log(`✅ Tunnel registered: ${tunnelId} -> ${localUrl}`);
    res.json({ success: true, tunnelId, publicUrl });
});

app.get('/', (req, res) => {
    res.send('<h1>🚀 Tunnel Server</h1><p>POST /api/tunnel/register</p>');
});

// ============ VIEWER PAGE ============

app.get('/t/:tunnelId', (req, res) => {
    const { tunnelId } = req.params;
    const tunnel = tunnels.get(tunnelId);
    if (!tunnel) return res.status(404).send('Tunnel not found');

    // NOTE: server.js mein LOCAL_URL hardcode mat karo
    // Client apna localUrl send karta hai sender-connect mein
    // Viewer page ko localUrl nahi chahiye — assets client-side handle honge

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
            padding: 10px 20px;
            font-size: 13px;
            position: fixed;
            top: 0; left: 0; right: 0;
            z-index: 999999;
            display: flex;
            align-items: center;
            gap: 10px;
            height: 42px;
        }
        .dot { width: 9px; height: 9px; border-radius: 50%; background: #4ade80; flex-shrink: 0; }
        .dot.off { background: #f87171; }
        #frame-wrapper { position: fixed; top: 42px; left: 0; right: 0; bottom: 0; display: none; }
        iframe { width: 100%; height: 100%; border: none; background: white; }
        .loading {
            position: fixed; top: 42px; left: 0; right: 0; bottom: 0;
            display: flex; align-items: center; justify-content: center;
            flex-direction: column; gap: 16px; background: #f9fafb; color: #6b7280;
        }
        .spinner {
            width: 40px; height: 40px;
            border: 3px solid #e5e7eb; border-top-color: #667eea;
            border-radius: 50%; animation: spin 0.8s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
    </style>
</head>
<body>
<div class="banner">
    <span class="dot" id="dot"></span>
    <span>🔗 Tunnel &nbsp;|&nbsp; <b id="status">Connecting...</b></span>
    <span style="opacity:0.7;font-size:11px;margin-left:auto">ID: ${tunnelId}</span>
</div>

<div class="loading" id="loading">
    <div class="spinner"></div>
    <div id="loading-text">Connecting...</div>
</div>

<div id="frame-wrapper">
    <iframe id="frame" allow="forms" sandbox="allow-scripts allow-forms allow-popups allow-modals allow-same-origin"></iframe>
</div>

<script>
(function() {
    var TUNNEL_ID = '${tunnelId}';
    var socket = io({ transports: ['websocket', 'polling'] });

    var sessionCookies = '';
    var csrfToken = '';
    var currentPath = '/';
    var localUrl = ''; // client se milega

    // ── Socket ──────────────────────────────────────────────────────────
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
        setText('Host is offline. Start the tunnel client.');
    });

    socket.on('tunnel-info', function(data) {
        if (data.localUrl) localUrl = data.localUrl;
    });

    socket.on('page-content', function(data) {
        if (data.cookies) sessionCookies = data.cookies;
        if (data.csrfToken) csrfToken = data.csrfToken;
        if (data.currentPath) currentPath = data.currentPath;
        if (data.localUrl) localUrl = data.localUrl;

        if (!data.html) {
            console.warn('page-content: html is empty, ignoring');
            return;
        }
        renderPage(data.html, localUrl, data.currentPath || currentPath);
    });

    socket.on('redirect', function(data) {
        navigateTo(data.url);
    });

    // ── Navigation ───────────────────────────────────────────────────────
    function navigateTo(url) {
        var path = url;
        try { var u = new URL(url); path = u.pathname + u.search + u.hash; } catch(e) {}
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

    // ── Rendering ────────────────────────────────────────────────────────
    function renderPage(html, base, path) {
        var frame = document.getElementById('frame');

        // Iframe mein inject: base tag + interceptor
        // Base tag local server pe point karega assets ke liye
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

    // iframe se messages
    window.addEventListener('message', function(e) {
        var msg = e.data;
        if (!msg || !msg.type) return;
        if (msg.type === 'navigate') { navigateTo(msg.url); }
        else if (msg.type === 'submit') { submitForm(msg.method, msg.action, msg.body); }
    });

    // ── Helpers ──────────────────────────────────────────────────────────
    function setStatus(text, isOff) {
        document.getElementById('status').textContent = text;
        var dot = document.getElementById('dot');
        if (isOff) dot.classList.add('off'); else dot.classList.remove('off');
    }
    function showLoading(text) {
        document.getElementById('loading').style.display = 'flex';
        document.getElementById('frame-wrapper').style.display = 'none';
        setText(text || 'Loading...');
    }
    function setText(t) { document.getElementById('loading-text').textContent = t; }

    showLoading('Connecting...');
})();
</script>
</body>
</html>`;

    res.send(viewerHtml);
});

// ============ WEBSOCKET ============

io.on('connection', (socket) => {
    console.log('🔌 Connected:', socket.id);

    socket.on('sender-connect', ({ tunnelId, localUrl }) => {
        const tunnel = tunnels.get(tunnelId);
        if (!tunnel) { console.log('❌ Unknown tunnel:', tunnelId); return; }
        tunnel.senderSocketId = socket.id;
        tunnel.isOnline = true;
        tunnel.localUrl = localUrl;
        console.log(`✅ Sender online: ${tunnelId} -> ${localUrl}`);
        socket.emit('sender-confirm', { status: 'online' });
    });

    socket.on('viewer-join', ({ tunnelId, path }) => {
        const tunnel = tunnels.get(tunnelId);
        if (!tunnel) return;
        if (!tunnel.isOnline) { socket.emit('host-offline'); return; }

        socket.join(tunnelId);
        console.log(`👁️  GET ${path}`);

        // Viewer ko localUrl bhi bhejo taaki assets sahi base mile
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
            console.log(`🔄 ${method} ${url}`);
            io.to(targetTunnel.senderSocketId).emit('forward-request', {
                requestId: Date.now() + '-' + Math.random(),
                method, url, body, headers, viewerSocketId
            });
        } else {
            console.log('❌ No tunnel found for viewer:', viewerSocketId);
        }
    });

    socket.on('page-response', ({ requestId, html, viewerSocketId, cookies, csrfToken, currentPath, redirectUrl }) => {
        if (redirectUrl) {
            io.to(viewerSocketId).emit('redirect', { url: redirectUrl });
        } else {
            io.to(viewerSocketId).emit('page-content', { html, cookies, csrfToken, currentPath });
        }
    });

    socket.on('request-response', ({ requestId, html, viewerSocketId, redirectUrl, cookies, csrfToken, currentPath }) => {
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
                console.log(`⚠️  Sender offline: ${tunnelId}`);
                io.to(tunnelId).emit('host-offline');
                break;
            }
        }
        console.log('❌ Disconnected:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('\n╔══════════════════════════════╗');
    console.log(`║  🚀 Tunnel Server :${PORT}      ║`);
    console.log('╚══════════════════════════════╝\n');
});