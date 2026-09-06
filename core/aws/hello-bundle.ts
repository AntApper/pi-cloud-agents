/**
 * Hello MicroVM Deployment Bundle Generator.
 * Creates the in-memory Dockerfile, guest server.js (hooks on 9000, app on 8080),
 * and deployment ZIP archive for AWS Lambda MicroVM deployment.
 */

import { createDeterministicZip } from "./zip.js";

export const DEFAULT_BASE_IMAGE = "public.ecr.aws/lambda/microvms:al2023-minimal:latest";

export function generateDockerfile(baseImage: string = DEFAULT_BASE_IMAGE): string {
  return `# Generated Dockerfile for pi-cloud-agents hello-microvm spike
FROM ${baseImage}

# Install Node.js 22 or fallback to system nodejs
RUN (dnf install -y nodejs22 || dnf install -y nodejs || (curl -fsSL https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-arm64.tar.xz | tar -xJ -C /usr/local --strip-components=1)) && dnf clean all

WORKDIR /app
COPY server.js /app/server.js

EXPOSE 9000
EXPOSE 8080

CMD ["node", "/app/server.js"]
`;
}

export function generateServerJs(): string {
  return `/**
 * In-VM Guest Server for pi-cloud-agents Hello MicroVM Spike.
 * Listens on port 9000 for AWS Lambda MicroVM lifecycle hooks.
 * Listens on port 8080 for application traffic (HTTP, WebSocket, SSE).
 */

const http = require('node:http');
const crypto = require('node:crypto');

// State recorded during execution
const state = {
  microvmId: null,
  runHookPayload: null,
  hooks: [],
  startTime: Date.now(),
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
  log(\`Hook request: \${method} \${url}\`);

  let body = '';
  req.on('data', chunk => {
    body += chunk;
  });

  req.on('end', () => {
    const hookName = url.split('/').pop() || 'unknown';
    const entry = { hook: hookName, path: url, method, time: Date.now() };
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
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', hook: hookName, receivedAt: entry.time }));
  });
});

hookServer.listen(9000, '0.0.0.0', () => {
  log('Hook server listening on 0.0.0.0:9000');
});

// ---------------------------------------------------------------------------
// Port 8080: App Server (HTTP + SSE + WebSocket)
// ---------------------------------------------------------------------------
const appServer = http.createServer((req, res) => {
  const url = req.url || '/';
  const method = req.method || 'GET';

  // SSE Heartbeat Stream
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

  // Health / Status / Echo endpoint
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

// WebSocket Upgrade & RFC 6455 Echo Server
appServer.on('upgrade', (req, socket, head) => {
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
    // Select the first requested subprotocol
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
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= 2) {
      const byte1 = buffer[0];
      const byte2 = buffer[1];
      const fin = (byte1 & 0x80) === 0x80;
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

      // Handle Ping -> Pong
      if (opcode === 0x09) {
        sendFrame(socket, 0x0a, payload);
      }
      // Handle Close
      else if (opcode === 0x08) {
        sendFrame(socket, 0x08, payload);
        socket.end();
      }
      // Handle Text (0x01) or Binary (0x02) -> Echo back
      else if (opcode === 0x01 || opcode === 0x02) {
        sendFrame(socket, opcode, payload);
      }
    }
  });

  socket.on('error', err => {
    log(\`WebSocket socket error: \${err.message}\`);
  });
});

function sendFrame(socket, opcode, payload) {
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

appServer.listen(8080, '0.0.0.0', () => {
  log('App server listening on 0.0.0.0:8080');
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
 * Generates a test 3 KB JSON payload for RunMicrovm hook verification.
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
