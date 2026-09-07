// Simple HTTP forward proxy with logging
// Captures all request URLs, methods, and hosts (including HTTPS via CONNECT)
// For HTTPS: logs the CONNECT target (domain:port) without decrypting content
// For HTTP: logs full request details including body

const http = require('http');
const net = require('net');
const PORT = parseInt(process.env.YAUTJA_PROXY_PORT || '9877');
const MAX_CAPTURE_BYTES = 256 * 1024;

const requests = [];
let nextId = 1;

function logRequest(entry) {
  requests.push(entry);
  if (requests.length > 5000) requests.splice(0, requests.length - 5000);
  // Emit as JSON line for parent process to read
  process.stdout.write(JSON.stringify(entry) + '\n');
}

const server = http.createServer((req, res) => {
  // HTTP request (not HTTPS) — full interception
  const url = req.url;
  const host = (req.headers.host || new URL(url).host);

  const entry = {
    id: 'proxy-' + (nextId++),
    protocol: 'http',
    url,
    method: req.method,
    host,
    requestHeaders: { ...req.headers },
    timestamp: Date.now(),
  };

  // Collect request body
  const reqBody = [];
  let reqBodyBytes = 0;
  req.on('data', chunk => {
    if (reqBodyBytes >= MAX_CAPTURE_BYTES) return;
    const remaining = MAX_CAPTURE_BYTES - reqBodyBytes;
    const captured = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
    reqBody.push(captured);
    reqBodyBytes += captured.length;
  });
  req.on('end', () => {
    if (reqBody.length > 0) entry.requestBody = Buffer.concat(reqBody).toString('utf8');

    // Forward to destination
    const proxyReq = http.request(url, {
      method: req.method,
      headers: req.headers,
    }, (proxyRes) => {
      entry.status = proxyRes.statusCode;
      entry.responseHeaders = { ...proxyRes.headers };
      entry.mimeType = proxyRes.headers['content-type'] || '';

      const respBody = [];
      let respBodyBytes = 0;
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.on('data', chunk => {
        const ct = entry.mimeType;
        if ((ct.includes('json') || ct.includes('text') || ct.includes('javascript') || ct.includes('xml'))
            && respBodyBytes < MAX_CAPTURE_BYTES) {
          const remaining = MAX_CAPTURE_BYTES - respBodyBytes;
          const captured = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
          respBody.push(captured);
          respBodyBytes += captured.length;
        }
        res.write(chunk);
      });
      proxyRes.on('end', () => {
        if (respBody.length > 0) entry.responseBody = Buffer.concat(respBody).toString('utf8');
        entry.durationMs = Date.now() - entry.timestamp;
        logRequest(entry);
        res.end();
      });
      proxyRes.on('error', () => { res.end(); });
    });

    proxyReq.on('error', (e) => {
      entry.error = e.message;
      entry.durationMs = Date.now() - entry.timestamp;
      logRequest(entry);
      try { res.writeHead(502); res.end('Bad Gateway'); } catch {}
    });

    if (reqBody.length > 0) {
      proxyReq.write(Buffer.concat(reqBody));
    }
    proxyReq.end();
  });
});

// HTTPS CONNECT — tunnel without decryption, but log the target
server.on('connect', (req, clientSocket, head) => {
  const [host, port] = req.url.split(':');
  const targetPort = parseInt(port) || 443;

  const entry = {
    id: 'proxy-' + (nextId++),
    protocol: 'https',
    method: 'CONNECT',
    host: req.url,
    domain: host,
    port: targetPort,
    timestamp: Date.now(),
  };

  const serverSocket = net.connect(targetPort, host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length > 0) serverSocket.write(head);
    serverSocket.pipe(clientSocket);
    clientSocket.pipe(serverSocket);

    // Log on successful connection
    entry.status = 200;
    entry.connected = true;
    logRequest(entry);
  });

  serverSocket.on('error', (e) => {
    entry.error = e.message;
    entry.connected = false;
    logRequest(entry);
    clientSocket.end();
  });

  clientSocket.on('error', () => { serverSocket.destroy(); });
});

// Query interface via stdin
let stdinBuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  stdinBuf += data;
  let idx;
  while ((idx = stdinBuf.indexOf('\n')) >= 0) {
    const line = stdinBuf.substring(0, idx).trim();
    stdinBuf = stdinBuf.substring(idx + 1);
    if (!line) continue;
    try {
      const cmd = JSON.parse(line);
      if (cmd.action === 'list') {
        let filtered = requests;
        if (cmd.hostPattern) filtered = filtered.filter(r => (r.host || '').includes(cmd.hostPattern));
        const limited = filtered.slice(-(cmd.limit || 100));
        process.stdout.write('RESULT:' + JSON.stringify({ requests: limited, count: limited.length, total: requests.length }) + '\n');
      } else if (cmd.action === 'clear') {
        requests.length = 0;
        process.stdout.write('RESULT:' + JSON.stringify({ cleared: true }) + '\n');
      } else if (cmd.action === 'stats') {
        const hosts = {};
        for (const r of requests) hosts[r.host] = (hosts[r.host] || 0) + 1;
        process.stdout.write('RESULT:' + JSON.stringify({ total: requests.length, uniqueHosts: Object.keys(hosts).length, hosts }) + '\n');
      }
    } catch (e) {}
  }
});

server.listen(PORT, '127.0.0.1', () => {
  process.stderr.write('[Proxy] Listening on 127.0.0.1:' + PORT + '\n');
});

// Keep alive
setInterval(() => {}, 10000);

process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT', () => { server.close(); process.exit(0); });

// Parent-death watchdog: this proxy is spawned by the helmet and its stdin
// is piped from the parent. When the helmet dies (even with -9), stdin
// closes — exit instead of becoming a zombie holding port 9877 and the
// Windows system proxy settings.
process.stdin.on('end', () => {
  server.close();
  process.exit(0);
});
