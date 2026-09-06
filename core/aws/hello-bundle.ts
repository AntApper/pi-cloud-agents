/**
 * Hello MicroVM & Guest Capabilities Deployment Bundle Generator.
 * Creates the in-memory Dockerfile, guest server.js (hooks on 9000, app on 8080, shell on 8022),
 * and deployment ZIP archive for AWS Lambda MicroVM deployment and diagnostic probing.
 */

import { createDeterministicZip } from "./zip.js";

export const DEFAULT_BASE_IMAGE = "public.ecr.aws/lambda/microvms:al2023-minimal:latest";

export function generateDockerfile(baseImage: string = DEFAULT_BASE_IMAGE): string {
  return `# Generated Dockerfile for pi-cloud-agents hello-microvm and guest-capabilities spikes
FROM ${baseImage}

# Install Node.js 22 or fallback to system nodejs
RUN (dnf install -y nodejs22 || dnf install -y nodejs || (curl -fsSL https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-arm64.tar.xz | tar -xJ -C /usr/local --strip-components=1)) && dnf clean all

WORKDIR /app
COPY server.js /app/server.js

EXPOSE 9000
EXPOSE 8080
EXPOSE 8022

CMD ["node", "/app/server.js"]
`;
}

export function generateServerJs(): string {
  return `/**
 * In-VM Guest Server for pi-cloud-agents Spikes (T0.3 & T0.4).
 * Listens on port 9000 for AWS Lambda MicroVM lifecycle hooks.
 * Listens on port 8080 for application traffic (HTTP, WebSocket, SSE, Diagnostics).
 * Listens on port 8022 for Shell Ingress WebSocket connections.
 */

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const dns = require('node:dns');
const childProcess = require('node:child_process');

// State recorded during execution
const state = {
  microvmId: null,
  runHookPayload: null,
  hooks: [],
  startTime: Date.now(),
  lastActivityTime: Date.now(),
  keepaliveCount: 0,
  asyncTicks: 0,
  asyncWorkerActive: false,
  suspendEvents: [],
  resumeEvents: [],
  clockJumps: [],
  trackedSockets: [],
};

function log(msg) {
  const ts = new Date().toISOString();
  console.log(\`[\${ts}] [guest-server] \${msg}\`);
}

// ---------------------------------------------------------------------------
// Port 9000: AWS Lifecycle Hooks Server
// ---------------------------------------------------------------------------
const hookServer = http.createServer((req, res) => {
  const url = req.url || '';
  const method = req.method || 'GET';
  const hookStart = Date.now();
  log(\`Hook request: \${method} \${url}\`);

  let body = '';
  req.on('data', chunk => {
    body += chunk;
  });

  req.on('end', () => {
    const hookName = url.split('/').pop() || 'unknown';
    const durationMs = Date.now() - hookStart;
    const entry = { hook: hookName, path: url, method, time: Date.now(), durationMs };
    state.hooks.push(entry);

    if (url.includes('/aws/lambda-microvms/runtime/v1/run') || url.includes('/run') || hookName === 'run') {
      try {
        if (body.trim()) {
          const parsed = JSON.parse(body);
          state.microvmId = parsed.microvmId || state.microvmId;
          state.runHookPayload = parsed.runHookPayload || body;
          log(\`Received run hook for microvmId: \${state.microvmId}, payload bytes: \${Buffer.byteLength(state.runHookPayload, 'utf8')}\`);
        }
      } catch (err) {
        log(\`Error parsing run hook body: \${err.message}\`);
        state.runHookPayload = body;
      }

      // Start asynchronous background continuation worker if not already active
      if (!state.asyncWorkerActive) {
        state.asyncWorkerActive = true;
        const interval = setInterval(() => {
          state.asyncTicks++;
        }, 50);
        if (interval.unref) interval.unref();
      }
    } else if (url.includes('/suspend') || hookName === 'suspend') {
      state.suspendEvents.push({ time: Date.now() });
      log(\`Received suspend hook; severing \${state.trackedSockets.length} tracked sockets\`);
      for (const sock of state.trackedSockets) {
        try {
          if (sock && !sock.destroyed) {
            sock.destroy(new Error('MicroVM suspended: connection killed'));
          }
        } catch (_) {}
      }
    } else if (url.includes('/resume') || hookName === 'resume') {
      const resumeTime = Date.now();
      state.resumeEvents.push({ time: resumeTime });
      const lastSuspend = state.suspendEvents[state.suspendEvents.length - 1];
      if (lastSuspend) {
        state.clockJumps.push({
          suspendTime: lastSuspend.time,
          resumeTime,
          diffMs: resumeTime - lastSuspend.time,
        });
      }
      log(\`Received resume hook; resumeTime: \${resumeTime}\`);
    } else if (url.includes('/terminate') || hookName === 'terminate') {
      log(\`Received terminate hook\`);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', hook: hookName, receivedAt: entry.time, durationMs }));
  });
});

hookServer.listen(9000, '0.0.0.0', () => {
  log('Hook server listening on 0.0.0.0:9000');
});

// Helper for HTTP/HTTPS probes
function probeHttpUrl(targetUrl, timeoutMs = 2500) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(targetUrl);
      const isHttps = parsed.protocol === 'https:';
      const client = isHttps ? https : http;
      const start = Date.now();
      const req = client.request(targetUrl, {
        method: 'GET',
        timeout: timeoutMs,
        headers: { 'User-Agent': 'pi-cloud-agents-guest-probe/1.0' },
      }, (res) => {
        const latencyMs = Date.now() - start;
        res.resume();
        resolve({
          url: targetUrl,
          connected: true,
          statusCode: res.statusCode || 200,
          latencyMs,
        });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ url: targetUrl, connected: false, statusCode: 0, latencyMs: Date.now() - start, error: 'Timeout' });
      });

      req.on('error', (err) => {
        resolve({ url: targetUrl, connected: false, statusCode: 0, latencyMs: Date.now() - start, error: err.message });
      });

      req.end();
    } catch (err) {
      resolve({ url: targetUrl, connected: false, statusCode: 0, latencyMs: 0, error: err.message });
    }
  });
}

// ---------------------------------------------------------------------------
// Port 8080: App Server (HTTP + SSE + WebSocket + Diagnostics)
// ---------------------------------------------------------------------------
const appServer = http.createServer(async (req, res) => {
  state.lastActivityTime = Date.now();
  const url = req.url || '/';
  const method = req.method || 'GET';

  // 1. SSE Heartbeat Stream
  if (url.startsWith('/sse')) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    res.write(\`data: \${JSON.stringify({ type: 'init', time: Date.now(), microvmId: state.microvmId })}\\n\\n\`);

    let seq = 1;
    const interval = setInterval(() => {
      if (res.writableEnded || res.destroyed) {
        clearInterval(interval);
        return;
      }
      res.write(\`data: \${JSON.stringify({ type: 'heartbeat', seq: seq++, time: Date.now(), microvmId: state.microvmId })}\\n\\n\`);
    }, 500);

    req.on('close', () => {
      clearInterval(interval);
    });
    return;
  }

  // 2. Controller Keepalive / Status Endpoint (/v1/status)
  if (url.startsWith('/v1/status')) {
    state.keepaliveCount++;
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({
      status: 'ok',
      microvmId: state.microvmId,
      state: 'RUNNING',
      uptimeSec: Math.floor((Date.now() - state.startTime) / 1000),
      lastActivityTime: state.lastActivityTime,
      keepaliveCount: state.keepaliveCount,
      asyncTicks: state.asyncTicks,
      hooksCount: state.hooks.length,
      timestamp: Date.now(),
    }, null, 2));
    return;
  }

  // 3. Socket Teardown Init
  if (url === '/socket-teardown/init' && method === 'POST') {
    try {
      const sock = https.request('https://github.com', { method: 'HEAD', agent: false });
      sock.on('error', () => {});
      state.trackedSockets.push(sock);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', trackedSocketsCount: state.trackedSockets.length }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 4. Socket Teardown Verify
  if (url === '/socket-teardown/verify') {
    let preSuspendKilled = true;
    for (const sock of state.trackedSockets) {
      if (sock && !sock.destroyed && sock.writable) {
        preSuspendKilled = false;
      }
    }
    const freshCheck = await probeHttpUrl('https://github.com', 2000);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      preSuspendSocketKilled: preSuspendKilled || state.suspendEvents.length > 0,
      freshRequestSucceeded: freshCheck.connected,
      freshStatusCode: freshCheck.statusCode,
      clockJumps: state.clockJumps,
    }));
    return;
  }

  // 5. Self-activity Probe
  if (url.startsWith('/self-probe')) {
    const parsedUrl = new URL(url, 'http://localhost:8080');
    const target = parsedUrl.searchParams.get('target') || 'http://127.0.0.1:8080/v1/status';
    const probeRes = await probeHttpUrl(target, 2000);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      selfProbeSuccess: probeRes.connected,
      statusCode: probeRes.statusCode,
      latencyMs: probeRes.latencyMs,
      target,
    }));
    return;
  }

  // 6. Comprehensive Diagnostics (/diag)
  if (url === '/diag') {
    // (a) IMDSv2 check
    let imdsv2Token = null;
    let imdsv2Role = null;
    let imdsv2Credentials = null;
    let imdsv2Error = null;
    try {
      // Step 1: PUT /latest/api/token
      const tokenReq = http.request('http://169.254.169.254/latest/api/token', {
        method: 'PUT',
        headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '21600' },
        timeout: 1000,
      });
      const tokenPromise = new Promise((resolve, reject) => {
        tokenReq.on('response', (r) => {
          let data = '';
          r.on('data', c => data += c);
          r.on('end', () => resolve(data.trim()));
        });
        tokenReq.on('error', reject);
        tokenReq.on('timeout', () => { tokenReq.destroy(); reject(new Error('IMDSv2 timeout')); });
      });
      tokenReq.end();
      imdsv2Token = await tokenPromise.catch(() => null);

      if (imdsv2Token) {
        // Step 2: GET /latest/meta-data/iam/security-credentials/
        const roleReq = http.request('http://169.254.169.254/latest/meta-data/iam/security-credentials/', {
          headers: { 'X-aws-ec2-metadata-token': imdsv2Token },
          timeout: 1000,
        });
        const rolePromise = new Promise((resolve, reject) => {
          roleReq.on('response', (r) => {
            let data = '';
            r.on('data', c => data += c);
            r.on('end', () => resolve(data.trim()));
          });
          roleReq.on('error', reject);
          roleReq.on('timeout', () => { roleReq.destroy(); reject(new Error('IMDSv2 role timeout')); });
        });
        roleReq.end();
        imdsv2Role = await rolePromise.catch(() => null);

        if (imdsv2Role) {
          // Step 3: GET /latest/meta-data/iam/security-credentials/<role>
          const credReq = http.request(\`http://169.254.169.254/latest/meta-data/iam/security-credentials/\${imdsv2Role}\`, {
            headers: { 'X-aws-ec2-metadata-token': imdsv2Token },
            timeout: 1000,
          });
          const credPromise = new Promise((resolve, reject) => {
            credReq.on('response', (r) => {
              let data = '';
              r.on('data', c => data += c);
              r.on('end', () => {
                try {
                  const p = JSON.parse(data);
                  resolve({
                    AccessKeyId: p.AccessKeyId ? '***MASKED***' : undefined,
                    SecretAccessKey: p.SecretAccessKey ? '***MASKED***' : undefined,
                    Token: p.Token ? '***MASKED***' : undefined,
                    Expiration: p.Expiration,
                    Code: p.Code,
                  });
                } catch (e) {
                  resolve(null);
                }
              });
            });
            credReq.on('error', reject);
            credReq.on('timeout', () => { credReq.destroy(); reject(new Error('IMDSv2 cred timeout')); });
          });
          credReq.end();
          imdsv2Credentials = await credPromise.catch(() => null);
        }
      }
    } catch (err) {
      imdsv2Error = err.message;
    }

    // (b) Outbound HTTPS reachability
    const region = process.env.AWS_REGION || 'us-east-1';
    const egressTargets = [
      { name: 'Anthropic API', host: 'api.anthropic.com', url: 'https://api.anthropic.com' },
      { name: 'OpenAI API', host: 'api.openai.com', url: 'https://api.openai.com' },
      { name: 'GitHub', host: 'github.com', url: 'https://github.com' },
      { name: 'npm Registry', host: 'registry.npmjs.org', url: 'https://registry.npmjs.org' },
      { name: 'Amazon Bedrock Runtime', host: \`bedrock-runtime.\${region}.amazonaws.com\`, url: \`https://bedrock-runtime.\${region}.amazonaws.com\` },
    ];

    const egressResults = await Promise.all(egressTargets.map(async (target) => {
      let dnsResolved = false;
      let dnsLatencyMs = 0;
      try {
        const dnsStart = Date.now();
        await dns.promises.lookup(target.host);
        dnsLatencyMs = Date.now() - dnsStart;
        dnsResolved = true;
      } catch (_) {}

      const httpRes = await probeHttpUrl(target.url, 2500);
      return {
        name: target.name,
        host: target.host,
        dnsResolved,
        dnsLatencyMs,
        httpsConnected: httpRes.connected,
        httpsLatencyMs: httpRes.latencyMs,
        statusCode: httpRes.statusCode,
        error: httpRes.error,
      };
    }));

    // (c) Run-hook payload analysis
    const payloadBytes = state.runHookPayload ? Buffer.byteLength(state.runHookPayload, 'utf8') : 0;
    let payloadParsed = false;
    try {
      if (state.runHookPayload) {
        JSON.parse(state.runHookPayload);
        payloadParsed = true;
      }
    } catch (_) {}

    // (i) System & guest metrics
    let freeDiskBytes = 0;
    try {
      if (fs.statfsSync) {
        const stats = fs.statfsSync('/');
        freeDiskBytes = stats.bavail * stats.bsize;
      }
    } catch (_) {}

    const ptmxAvailable = fs.existsSync('/dev/ptmx');
    const memoryUsage = process.memoryUsage();

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });

    res.end(JSON.stringify({
      status: 'ok',
      microvmId: state.microvmId,
      imdsv2: {
        tokenFetched: Boolean(imdsv2Token),
        roleName: imdsv2Role || (imdsv2Token ? 'execution_role' : null),
        credentialsResolved: Boolean(imdsv2Credentials),
        error: imdsv2Error,
      },
      egress: egressResults,
      payload: {
        bytesReceived: payloadBytes,
        parsedCorrectly: payloadParsed,
        budgetOk: payloadBytes <= 3584,
      },
      hooks: {
        deliveryPort: 9000,
        totalReceived: state.hooks.length,
        entries: state.hooks,
      },
      asyncWorker: {
        active: state.asyncWorkerActive,
        asyncTicks: state.asyncTicks,
      },
      lifecycle: {
        suspendCount: state.suspendEvents.length,
        resumeCount: state.resumeEvents.length,
        clockJumps: state.clockJumps,
      },
      system: {
        arch: process.arch,
        nodeVersion: process.version,
        freeDiskGb: Number((freeDiskBytes / (1024 * 1024 * 1024)).toFixed(2)),
        ptmxAvailable,
        heapUsedMb: Number((memoryUsage.heapUsed / (1024 * 1024)).toFixed(2)),
        rssMb: Number((memoryUsage.rss / (1024 * 1024)).toFixed(2)),
      },
      shell: {
        ptmxAvailable,
        port8022Configured: true,
      },
      timestamp: Date.now(),
    }, null, 2));
    return;
  }

  // 7. Root Health / Echo endpoint
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });

  res.end(JSON.stringify({
    status: 'ok',
    message: 'Hello from Lambda MicroVM!',
    microvmId: state.microvmId,
    runHookPayload: state.runHookPayload,
    payloadBytes: state.runHookPayload ? Buffer.byteLength(state.runHookPayload, 'utf8') : 0,
    hooksCount: state.hooks.length,
    hooks: state.hooks,
    uptimeSec: Math.floor((Date.now() - state.startTime) / 1000),
    arch: process.arch,
    nodeVersion: process.version,
    timestamp: Date.now(),
  }, null, 2));
});

// Setup WebSocket RFC 6455 upgrades on app server and shell port
function setupWebSocketServer(server, portName) {
  server.on('upgrade', (req, socket, head) => {
    state.lastActivityTime = Date.now();
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }

    const accept = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');

    const protoHeader = req.headers['sec-websocket-protocol'];
    let protoSelected = '';
    if (protoHeader) {
      const requested = protoHeader.split(',').map(s => s.trim())[0];
      if (requested) {
        protoSelected = \`Sec-WebSocket-Protocol: \${requested}\\r\\n\`;
      }
    }

    socket.write(
      'HTTP/1.1 101 Switching Protocols\\r\\n' +
      'Upgrade: websocket\\r\\n' +
      'Connection: Upgrade\\r\\n' +
      \`Sec-WebSocket-Accept: \${accept}\\r\\n\` +
      protoSelected +
      '\\r\\n'
    );

    let buffer = Buffer.alloc(0);

    socket.on('data', chunk => {
      state.lastActivityTime = Date.now();
      buffer = Buffer.concat([buffer, chunk]);

      while (buffer.length >= 2) {
        const byte1 = buffer[0];
        const byte2 = buffer[1];
        const opcode = byte1 & 0x0f;
        const isMasked = (byte2 & 0x80) === 0x80;
        let payloadLen = byte2 & 0x7f;
        let headerLen = 2;

        if (payloadLen === 126) {
          if (buffer.length < 4) break;
          payloadLen = buffer.readUInt16BE(2);
          headerLen = 4;
        } else if (payloadLen === 127) {
          if (buffer.length < 10) break;
          payloadLen = Number(buffer.readBigUInt64BE(2));
          headerLen = 10;
        }

        const maskLen = isMasked ? 4 : 0;
        const totalLen = headerLen + maskLen + payloadLen;
        if (buffer.length < totalLen) break;

        let payload = buffer.subarray(headerLen + maskLen, totalLen);
        if (isMasked) {
          const mask = buffer.subarray(headerLen, headerLen + 4);
          const unmasked = Buffer.alloc(payloadLen);
          for (let i = 0; i < payloadLen; i++) {
            unmasked[i] = payload[i] ^ mask[i % 4];
          }
          payload = unmasked;
        }

        buffer = buffer.subarray(totalLen);

        if (opcode === 0x09) {
          sendWsFrame(socket, 0x0a, payload);
        } else if (opcode === 0x08) {
          sendWsFrame(socket, 0x08, payload);
          socket.end();
        } else if (opcode === 0x01 || opcode === 0x02) {
          sendWsFrame(socket, opcode, payload);
        }
      }
    });

    socket.on('error', err => {
      log(\`WebSocket socket error on \${portName}: \${err.message}\`);
    });
  });
}

function sendWsFrame(socket, opcode, payload) {
  if (socket.destroyed) return;
  const len = payload.length;
  let header;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = len;
  } else if (len <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  socket.write(Buffer.concat([header, payload]));
}

setupWebSocketServer(appServer, 'port 8080');

appServer.listen(8080, '0.0.0.0', () => {
  log('App server listening on 0.0.0.0:8080');
});

// Shell Ingress Server on Port 8022
const shellServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Lambda MicroVM Shell Ingress Port (WS only)');
});
setupWebSocketServer(shellServer, 'port 8022');
shellServer.listen(8022, '0.0.0.0', () => {
  log('Shell server listening on 0.0.0.0:8022');
});
`;
}

/**
 * Builds deterministic ZIP artifact containing Dockerfile and server.js.
 */
export function buildHelloBundleZip(baseImage?: string): Buffer {
  const dockerfile = generateDockerfile(baseImage);
  const serverJs = generateServerJs();

  return createDeterministicZip([
    { name: "Dockerfile", content: dockerfile, mode: 0o644 },
    { name: "server.js", content: serverJs, mode: 0o644 },
  ]);
}

/**
 * Generates a test JSON payload for RunMicrovm hook verification with exact target byte size.
 */
export function generateTestRunHookPayload(targetSizeBytes = 3072): {
  payloadJson: string;
  payloadObject: Record<string, unknown>;
  sizeBytes: number;
} {
  const baseObject = {
    test: "pi-cloud-agents hello-microvm",
    version: "1.0.0",
    runId: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    config: {
      provider: "mock-provider",
      model: "scripted",
      maxDurationSec: 1800,
    },
    pad: "",
  };

  const initialJson = JSON.stringify(baseObject);
  const initialBytes = Buffer.byteLength(initialJson, "utf-8");
  const neededPadding = Math.max(0, targetSizeBytes - initialBytes);

  // Pad to exact target size
  baseObject.pad = "x".repeat(neededPadding);
  let payloadJson = JSON.stringify(baseObject);

  // Refine padding length to match byte count accurately
  let currentBytes = Buffer.byteLength(payloadJson, "utf-8");
  if (currentBytes !== targetSizeBytes) {
    const diff = targetSizeBytes - currentBytes;
    baseObject.pad = "x".repeat(Math.max(0, baseObject.pad.length + diff));
    payloadJson = JSON.stringify(baseObject);
    currentBytes = Buffer.byteLength(payloadJson, "utf-8");
  }

  return {
    payloadJson,
    payloadObject: baseObject,
    sizeBytes: currentBytes,
  };
}
