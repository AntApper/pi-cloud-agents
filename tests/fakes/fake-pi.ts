/**
 * Fake pi executable running in RPC mode over stdin/stdout.
 * Implements LF-delimited JSONL streaming for testing pi-process manager.
 */

import fs from "node:fs";
import path from "node:path";

interface ParsedArgs {
  mode?: string;
  sessionDir?: string;
  sessionFile?: string;
  provider?: string;
  model?: string;
  thinking?: string;
  approve?: boolean;
  extensions: string[];
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    extensions: [],
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--mode") {
      parsed.mode = args[++i];
    } else if (arg === "--session-dir") {
      parsed.sessionDir = args[++i];
    } else if (arg === "--session") {
      parsed.sessionFile = args[++i];
    } else if (arg === "--provider") {
      parsed.provider = args[++i];
    } else if (arg === "--model") {
      parsed.model = args[++i];
    } else if (arg === "--thinking") {
      parsed.thinking = args[++i];
    } else if (arg === "--approve") {
      parsed.approve = true;
    } else if (arg === "-e" || arg === "--extension") {
      const ext = args[++i];
      if (ext) parsed.extensions.push(ext);
    }
  }

  return parsed;
}

const args = parseArgs(process.argv.slice(2));

const sessionId = args.sessionFile
  ? path.basename(args.sessionFile).replace(/\.jsonl$/, "")
  : `session-${Date.now()}`;

let sessionFilePath: string;
if (args.sessionFile) {
  sessionFilePath = args.sessionFile;
} else if (args.sessionDir) {
  fs.mkdirSync(args.sessionDir, { recursive: true });
  sessionFilePath = path.join(args.sessionDir, `${sessionId}.jsonl`);
} else {
  sessionFilePath = path.join(process.cwd(), `${sessionId}.jsonl`);
}

// Ensure session file exists
if (!fs.existsSync(sessionFilePath)) {
  fs.writeFileSync(
    sessionFilePath,
    `${JSON.stringify({ type: "session_start", id: sessionId, createdAt: new Date().toISOString() })}\n`,
    "utf8",
  );
}

function sendLine(obj: Record<string, unknown>): void {
  const line = `${JSON.stringify(obj)}\n`;
  process.stdout.write(line);

  // Append to session file
  try {
    fs.appendFileSync(sessionFilePath, line, "utf8");
  } catch {
    // Ignore session write errors
  }
}

let isAborted = false;

async function handleCommand(command: Record<string, unknown>): Promise<void> {
  const id = (command.id as string) || `req-${Date.now()}`;
  const type = command.type as string;

  if (type === "get_state") {
    sendLine({
      id,
      type: "response",
      success: true,
      data: {
        state: "idle",
        sessionId,
        sessionFile: sessionFilePath,
        model: {
          provider: args.provider || "anthropic",
          id: args.model || "claude-sonnet-4-6",
        },
      },
    });
    return;
  }

  if (type === "abort") {
    isAborted = true;
    sendLine({
      id,
      type: "response",
      success: true,
      data: { aborted: true },
    });
    sendLine({
      type: "agent_settled",
      status: "aborted",
      sessionId,
    });
    return;
  }

  if (type === "prompt" || type === "steer" || type === "follow_up") {
    const message = (command.message as string) || (command.prompt as string) || "";

    // Crash simulation trigger
    if (message.includes("__CRASH__")) {
      sendLine({
        id,
        type: "response",
        success: true,
      });
      // Simulate unhandled crash
      process.stderr.write("FATAL: Simulated process crash trigger received\n");
      process.exit(1);
    }

    sendLine({
      id,
      type: "response",
      success: true,
      data: { queued: true },
    });

    isAborted = false;

    // Emit event stream
    sendLine({ type: "agent_start", sessionId });
    sendLine({ type: "turn_start", turnIndex: 0, sessionId });

    await new Promise((resolve) => setTimeout(resolve, 20));
    if (isAborted) return;

    const msgId = `msg-${Date.now()}`;
    sendLine({
      type: "message_start",
      id: msgId,
      role: "assistant",
      sessionId,
    });

    if (message.includes("__U2028__")) {
      // Test payload containing Unicode line separator U+2028 and paragraph separator U+2029
      const textWithSeparators = "Line1\u2028Line2\u2029Line3";
      sendLine({
        type: "message_update",
        id: msgId,
        role: "assistant",
        content: [{ type: "text", text: textWithSeparators }],
        sessionId,
      });

      sendLine({
        type: "message_end",
        id: msgId,
        role: "assistant",
        content: [{ type: "text", text: textWithSeparators }],
        sessionId,
      });
    } else {
      sendLine({
        type: "message_update",
        id: msgId,
        role: "assistant",
        content: [{ type: "text", text: "Processing..." }],
        sessionId,
      });

      await new Promise((resolve) => setTimeout(resolve, 20));
      if (isAborted) return;

      sendLine({
        type: "message_end",
        id: msgId,
        role: "assistant",
        content: [{ type: "text", text: `Completed: ${message}` }],
        sessionId,
      });
    }

    sendLine({ type: "turn_end", turnIndex: 0, sessionId });
    sendLine({ type: "agent_settled", status: "idle", sessionId });
    return;
  }

  // Generic fallback
  sendLine({
    id,
    type: "response",
    success: true,
    data: { acknowledged: true },
  });
}

// Buffer incoming chunks on stdin and split STRICTLY on '\n' (LF, byte 0x0A)
let inputBuffer = Buffer.alloc(0);

process.stdin.on("data", (chunk: Buffer) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);

  while (true) {
    const newlineIndex = inputBuffer.indexOf(0x0a);
    if (newlineIndex === -1) break;

    const lineBuffer = inputBuffer.subarray(0, newlineIndex);
    inputBuffer = inputBuffer.subarray(newlineIndex + 1);

    const lineText = lineBuffer.toString("utf8").trim();
    if (lineText.length > 0) {
      try {
        const parsed = JSON.parse(lineText);
        handleCommand(parsed);
      } catch (_err) {
        process.stderr.write(`Invalid JSON RPC input: ${lineText}\n`);
      }
    }
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});
