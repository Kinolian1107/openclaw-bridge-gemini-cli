#!/usr/bin/env node
/**
 * geminicli-bridge v1.0 — OpenAI-compatible API proxy for Gemini CLI
 *
 * Architecture:
 *   OpenClaw  ──(OpenAI API)──►  geminicli-bridge (port 18791)  ──►  gemini --prompt --output-format stream-json
 *
 * This proxy server lets OpenClaw call Gemini CLI's AI models (e.g. gemini-3-pro-preview)
 * through an OpenAI-compatible API endpoint.
 *
 * Key differences from cursor-bridge:
 *   - Uses Gemini CLI's headless mode (--prompt) instead of cursor-agent
 *   - Uses --output-format stream-json for structured JSONL events
 *   - Uses --output-format json for non-streaming responses
 *   - Gemini CLI manages its own auth (Google OAuth / API key / Vertex AI)
 *   - Uses --approval-mode plan for read-only (safe) mode
 *   - Uses -y (--yolo) for auto-approve mode
 *   - No native tool injection needed (Gemini CLI has its own tool management)
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Configuration ───────────────────────────────────────────────
const CONFIG = {
    port: parseInt(process.env.BRIDGE_PORT || "18791"),
    host: process.env.BRIDGE_HOST || "127.0.0.1",
    geminiModel: process.env.GEMINI_MODEL || "gemini-3-pro-preview",
    geminiBin: process.env.GEMINI_BIN || "gemini",
    // Approval mode: 'default', 'auto_edit', 'yolo'
    // 'yolo' = auto-approve all tool calls (default for bridge mode,
    //          since the bridge only relays prompts from OpenClaw)
    // Note: 'plan' mode requires gemini CLI experimental settings
    approvalMode: process.env.GEMINI_APPROVAL_MODE || "yolo",
    timeoutMs: parseInt(process.env.BRIDGE_TIMEOUT_MS || "300000"), // 5 minutes
    // Maximum prompt length (chars) to pass as CLI argument.
    // Above this, prompt is written to a temp file and piped via stdin.
    maxArgLen: parseInt(process.env.BRIDGE_MAX_ARG_LEN || "32768"),
    // Token estimation ratio: chars per token (lower = more conservative)
    charsPerToken: parseFloat(process.env.BRIDGE_CHARS_PER_TOKEN || "3.5"),
    // Working directory for Gemini CLI (affects file access scope)
    workingDir: process.env.GEMINI_WORKING_DIR || process.env.HOME,
};

// ─── Helpers ─────────────────────────────────────────────────────

/**
 * Extract text content from an OpenAI message content field
 * (handles both string and array-of-content-parts formats)
 */
function getContent(msg) {
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
        return msg.content
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n");
    }
    return String(msg.content ?? "");
}

/**
 * Estimate token count from a string.
 */
function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / CONFIG.charsPerToken);
}

/**
 * Convert OpenAI-format messages to a single prompt string for Gemini CLI.
 */
function messagesToPrompt(messages) {
    const parts = [];

    for (const msg of messages) {
        const content = getContent(msg);
        if (!content) continue;

        switch (msg.role) {
            case "system":
                parts.push(`[System Instructions]\n${content}\n[End System Instructions]`);
                break;
            case "user":
                parts.push(`[User]\n${content}`);
                break;
            case "assistant":
                parts.push(`[Assistant]\n${content}`);
                break;
            case "tool":
                parts.push(`[Tool Result (${msg.tool_call_id || "unknown"})]\n${content}`);
                break;
            default:
                parts.push(content);
        }
    }

    return parts.join("\n\n");
}

/**
 * Read the full body from an HTTP request.
 */
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => resolve(Buffer.concat(chunks).toString()));
        req.on("error", reject);
    });
}

/**
 * Send an OpenAI-compatible error response.
 */
function sendError(res, status, message, type = "server_error") {
    if (res.headersSent) return;
    res.writeHead(status, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
    });
    res.end(
        JSON.stringify({
            error: { message, type, code: status },
        })
    );
}

/**
 * Create a temp file for large prompts and return its path.
 */
function writeTempPrompt(prompt) {
    const dir = mkdtempSync(join(tmpdir(), "geminicli-bridge-"));
    const file = join(dir, "prompt.txt");
    writeFileSync(file, prompt, "utf8");
    return file;
}

/**
 * Clean up temp file.
 */
function cleanupTempFile(filePath) {
    try {
        unlinkSync(filePath);
        const dir = filePath.replace(/\/[^/]+$/, "");
        require("node:fs").rmdirSync(dir);
    } catch { }
}

/**
 * Classify Gemini CLI errors.
 */
function classifyError(err, stderr) {
    const msg = (err?.message || "") + " " + (stderr || "");

    if (msg.includes("AuthError") || msg.includes("authentication") || msg.includes("credential")) {
        return { status: 401, message: "Gemini CLI authentication error. Run 'gemini' interactively to set up auth.", type: "auth_error" };
    }
    if (msg.includes("quota") || msg.includes("rate limit") || msg.includes("429")) {
        return { status: 429, message: "Rate limit or quota exceeded", type: "rate_limit" };
    }
    if (msg.includes("context") || msg.includes("token limit") || msg.includes("too long")) {
        return { status: 400, message: "Context window exceeded", type: "context_overflow" };
    }
    if (msg.includes("ENOENT") || msg.includes("not found")) {
        return { status: 500, message: `Gemini CLI binary not found at: ${CONFIG.geminiBin}. Install: npm install -g @anthropic-ai/gemini-cli`, type: "binary_not_found" };
    }
    if (msg.includes("timeout") || msg.includes("SIGTERM")) {
        return { status: 504, message: "Request timed out", type: "timeout" };
    }

    return { status: 500, message: msg.trim() || "Unknown Gemini CLI error", type: "server_error" };
}

// ─── Core: Run Gemini CLI ────────────────────────────────────────

function runGeminiCLI(prompt, model, stream, res) {
    const requestId = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const modelName = model || `gemini/${CONFIG.geminiModel}`;

    // Determine if we need to pipe prompt via stdin
    const useStdinPipe = prompt.length > CONFIG.maxArgLen;

    // Build Gemini CLI command arguments
    const args = [];

    // Model
    args.push("--model", CONFIG.geminiModel);

    // Output format
    if (stream) {
        args.push("--output-format", "stream-json");
    } else {
        args.push("--output-format", "json");
    }

    // Approval mode (yolo = auto-approve, plan = read-only)
    if (CONFIG.approvalMode === "yolo") {
        args.push("-y");
    } else if (CONFIG.approvalMode) {
        args.push("--approval-mode", CONFIG.approvalMode);
    }

    // Prompt (via argument or stdin)
    let tempFile = null;
    if (!useStdinPipe) {
        args.push("--prompt", prompt);
    } else {
        // Write to temp file, pipe via stdin
        tempFile = writeTempPrompt(prompt);
        args.push("--prompt", "-"); // read from stdin
    }

    console.log(
        `[${new Date().toISOString()}] → Request ${requestId.slice(-8)}: model=${CONFIG.geminiModel} stream=${stream} prompt=${prompt.length} chars (${useStdinPipe ? "stdin-pipe" : "arg"}) approval=${CONFIG.approvalMode}`
    );

    const proc = spawn(CONFIG.geminiBin, args, {
        cwd: CONFIG.workingDir,
        env: {
            ...process.env,
            // Ensure Gemini CLI doesn't try to open a terminal UI
            CI: "true",
            TERM: "dumb",
        },
        stdio: useStdinPipe ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    });

    // If using stdin pipe, feed the prompt
    if (useStdinPipe && tempFile) {
        const { createReadStream } = require("node:fs");
        const fileStream = createReadStream(tempFile);
        fileStream.pipe(proc.stdin);
        fileStream.on("end", () => {
            proc.stdin.end();
            cleanupTempFile(tempFile);
            tempFile = null;
        });
    }

    // Timeout
    const timer = setTimeout(() => {
        console.error(`[${new Date().toISOString()}] ✗ Request ${requestId.slice(-8)}: timeout after ${CONFIG.timeoutMs / 1000}s`);
        proc.kill("SIGTERM");
        setTimeout(() => proc.kill("SIGKILL"), 5000);
    }, CONFIG.timeoutMs);

    let stderrOutput = "";
    proc.stderr.on("data", (chunk) => {
        stderrOutput += chunk.toString();
    });

    const startTime = Date.now();

    if (stream) {
        // ── Streaming mode: parse Gemini CLI stream-json events ──
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "Access-Control-Allow-Origin": "*",
        });

        let buffer = "";
        let chunkIndex = 0;
        let totalContent = "";

        // Send initial SSE role chunk
        const roleChunk = {
            id: requestId,
            object: "chat.completion.chunk",
            created,
            model: modelName,
            choices: [
                {
                    index: 0,
                    delta: { role: "assistant", content: "" },
                    finish_reason: null,
                },
            ],
        };
        res.write(`data: ${JSON.stringify(roleChunk)}\n\n`);

        proc.stdout.on("data", (data) => {
            buffer += data.toString();
            const lines = buffer.split("\n");
            buffer = lines.pop() || ""; // keep incomplete last line in buffer

            for (const line of lines) {
                if (!line.trim()) continue;

                let event;
                try {
                    event = JSON.parse(line);
                } catch {
                    continue; // skip non-JSON lines (e.g. Gemini CLI log output on stdout)
                }

                // Process Gemini CLI stream-json events
                if (event.type === "message" && event.role === "assistant") {
                    const content = event.content || "";
                    if (!content) continue;

                    totalContent += content;
                    chunkIndex++;

                    const sseChunk = {
                        id: requestId,
                        object: "chat.completion.chunk",
                        created,
                        model: modelName,
                        choices: [
                            {
                                index: 0,
                                delta: { content },
                                finish_reason: null,
                            },
                        ],
                    };
                    res.write(`data: ${JSON.stringify(sseChunk)}\n\n`);
                }
                // tool_use events can be logged but are handled by Gemini CLI internally
                else if (event.type === "tool_use") {
                    console.log(`  [tool_use] ${event.tool_name} (${event.tool_id || ""})`);
                }
                else if (event.type === "tool_result") {
                    console.log(`  [tool_result] ${event.tool_id || ""}: ${event.status}`);
                }
                else if (event.type === "result") {
                    // Final result event - extract usage stats
                    const stats = event.stats || {};
                    const usage = {
                        prompt_tokens: stats.input_tokens || estimateTokens(prompt),
                        completion_tokens: stats.output_tokens || estimateTokens(totalContent),
                        total_tokens: stats.total_tokens || estimateTokens(prompt) + estimateTokens(totalContent),
                    };

                    // Send final chunk with finish_reason
                    const finalChunk = {
                        id: requestId,
                        object: "chat.completion.chunk",
                        created,
                        model: modelName,
                        choices: [
                            {
                                index: 0,
                                delta: {},
                                finish_reason: "stop",
                            },
                        ],
                        usage,
                    };
                    res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
                }
                else if (event.type === "error") {
                    console.error(`  [gemini-error] ${event.message || JSON.stringify(event)}`);
                }
            }
        });

        proc.on("close", (code) => {
            clearTimeout(timer);
            if (tempFile) cleanupTempFile(tempFile);

            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

            if (code !== 0 && !totalContent) {
                // Only send error if we haven't sent any content yet
                const classified = classifyError(null, stderrOutput);
                const errorChunk = {
                    id: requestId,
                    object: "chat.completion.chunk",
                    created,
                    model: modelName,
                    choices: [
                        {
                            index: 0,
                            delta: { content: `\n\n[Error: ${classified.message}]` },
                            finish_reason: "stop",
                        },
                    ],
                };
                res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
            }

            res.write("data: [DONE]\n\n");
            res.end();

            console.log(
                `[${new Date().toISOString()}] ✓ Request ${requestId.slice(-8)}: completed in ${elapsed}s (stream, ${totalContent.length} chars)`
            );
        });
    } else {
        // ── Non-streaming mode: collect full JSON response ──
        let stdout = "";

        proc.stdout.on("data", (data) => {
            stdout += data.toString();
        });

        proc.on("close", (code) => {
            clearTimeout(timer);
            if (tempFile) cleanupTempFile(tempFile);

            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

            if (code !== 0) {
                const classified = classifyError(null, stderrOutput);
                console.error(
                    `[${new Date().toISOString()}] ✗ Request ${requestId.slice(-8)}: exit code ${code} → ${classified.type}`
                );
                sendError(res, classified.status, classified.message, classified.type);
                return;
            }

            // Parse Gemini CLI JSON output
            let geminiResponse;
            try {
                // Gemini CLI might output log lines before the JSON, find the JSON part
                const jsonStart = stdout.indexOf("{");
                const jsonStr = jsonStart >= 0 ? stdout.slice(jsonStart) : stdout;
                geminiResponse = JSON.parse(jsonStr);
            } catch {
                console.error(`[${new Date().toISOString()}] ✗ Request ${requestId.slice(-8)}: failed to parse Gemini CLI output`);
                sendError(res, 500, "Failed to parse Gemini CLI response", "parse_error");
                return;
            }

            const responseText = geminiResponse.response || "";
            const stats = geminiResponse.stats || {};

            // Extract token usage from Gemini CLI stats
            let usage;
            const modelStats = stats.models?.[CONFIG.geminiModel];
            if (modelStats?.tokens) {
                usage = {
                    prompt_tokens: modelStats.tokens.prompt || modelStats.tokens.input || estimateTokens(prompt),
                    completion_tokens: modelStats.tokens.candidates || estimateTokens(responseText),
                    total_tokens: modelStats.tokens.total || estimateTokens(prompt) + estimateTokens(responseText),
                };
            } else {
                usage = {
                    prompt_tokens: estimateTokens(prompt),
                    completion_tokens: estimateTokens(responseText),
                    total_tokens: estimateTokens(prompt) + estimateTokens(responseText),
                };
            }

            const response = {
                id: requestId,
                object: "chat.completion",
                created,
                model: modelName,
                choices: [
                    {
                        index: 0,
                        message: {
                            role: "assistant",
                            content: responseText,
                        },
                        finish_reason: "stop",
                    },
                ],
                usage,
            };

            console.log(
                `[${new Date().toISOString()}] ✓ Request ${requestId.slice(-8)}: completed in ${elapsed}s (non-stream, ${responseText.length} chars, usage=${JSON.stringify(usage)})`
            );

            res.writeHead(200, {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
            });
            res.end(JSON.stringify(response));
        });
    }

    proc.on("error", (err) => {
        clearTimeout(timer);
        if (tempFile) cleanupTempFile(tempFile);

        const classified = classifyError(err, stderrOutput);
        console.error(
            `[${new Date().toISOString()}] ✗ Request ${requestId.slice(-8)}: spawn error: ${err.message} → ${classified.type}`
        );
        sendError(res, classified.status, classified.message, classified.type);
    });
}

// ─── HTTP Server ─────────────────────────────────────────────────

const server = createServer(async (req, res) => {
    // CORS preflight
    if (req.method === "OPTIONS") {
        res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
        });
        res.end();
        return;
    }

    const url = new URL(req.url, `http://${CONFIG.host}:${CONFIG.port}`);

    // ── Health check ──
    if (
        (url.pathname === "/health" || url.pathname === "/") &&
        req.method === "GET"
    ) {
        res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        });
        res.end(
            JSON.stringify({
                status: "ok",
                service: "geminicli-bridge",
                version: "1.0.0",
                model: CONFIG.geminiModel,
                approvalMode: CONFIG.approvalMode,
            })
        );
        return;
    }

    // ── GET /v1/models ──
    if (url.pathname === "/v1/models" && req.method === "GET") {
        res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        });
        res.end(
            JSON.stringify({
                object: "list",
                data: [
                    {
                        id: `gemini/${CONFIG.geminiModel}`,
                        object: "model",
                        created: Math.floor(Date.now() / 1000),
                        owned_by: "google",
                    },
                ],
            })
        );
        return;
    }

    // ── POST /v1/chat/completions ──
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
        let body;
        try {
            body = await readBody(req);
        } catch (err) {
            sendError(res, 400, "Failed to read request body");
            return;
        }

        let data;
        try {
            data = JSON.parse(body);
        } catch {
            sendError(res, 400, "Invalid JSON in request body", "invalid_request");
            return;
        }

        const messages = data.messages || [];
        const stream = data.stream === true;

        if (!messages.length) {
            sendError(res, 400, "No messages provided", "invalid_request");
            return;
        }

        // Convert messages to prompt
        const prompt = messagesToPrompt(messages);
        if (!prompt.trim()) {
            sendError(res, 400, "Empty prompt after processing messages", "invalid_request");
            return;
        }

        runGeminiCLI(prompt, data.model, stream, res);
        return;
    }

    // ── 404 ──
    sendError(res, 404, `Unknown endpoint: ${req.method} ${url.pathname}`, "not_found");
});

// ─── Start ───────────────────────────────────────────────────────

server.listen(CONFIG.port, CONFIG.host, () => {
    console.log(`
┌──────────────────────────────────────────────────────────┐
│              geminicli-bridge v1.0.0                      │
│    OpenAI-compatible API  →  Gemini CLI                  │
├──────────────────────────────────────────────────────────┤
│  Endpoint:   http://${CONFIG.host}:${CONFIG.port}/v1/chat/completions  │
│  Model:      ${CONFIG.geminiModel.padEnd(43)}│
│  Approval:   ${CONFIG.approvalMode.padEnd(43)}│
│  WorkingDir: ${CONFIG.workingDir.slice(-43).padEnd(43)}│
│  Timeout:    ${(CONFIG.timeoutMs / 1000 + "s").padEnd(43)}│
│  MaxArgLen:  ${(CONFIG.maxArgLen + " chars").padEnd(43)}│
├──────────────────────────────────────────────────────────┤
│  OpenClaw config:                                        │
│    baseUrl: http://${CONFIG.host}:${CONFIG.port}/v1${" ".repeat(20)}│
│    apiKey:  geminicli-bridge-local                       │
│    api:     openai-completions                           │
└──────────────────────────────────────────────────────────┘
  `);
});

server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
        console.error(
            `✗ Port ${CONFIG.port} is already in use. Set BRIDGE_PORT to use a different port.`
        );
    } else {
        console.error(`✗ Server error: ${err.message}`);
    }
    process.exit(1);
});

// Graceful shutdown
for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
        console.log(`\n[geminicli-bridge] Received ${signal}, shutting down...`);
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(1), 5000);
    });
}
