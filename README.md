# 🌉 geminicli-bridge

> OpenAI-compatible API proxy that bridges [OpenClaw](https://github.com/openclaw/openclaw) to [Gemini CLI](https://github.com/google-gemini/gemini-cli), enabling the use of Google's Gemini models as an OpenClaw AI provider — at zero API cost.

## ✨ Why?

[OpenClaw](https://github.com/openclaw/openclaw) is a powerful personal AI assistant that supports multiple AI providers through OpenAI-compatible APIs. [Gemini CLI](https://geminicli.com) provides free access to Google's Gemini models (including Gemini 3 Pro) with generous rate limits.

**geminicli-bridge** connects them: it runs a local HTTP server that accepts OpenAI-compatible API requests from OpenClaw and translates them into Gemini CLI headless mode invocations.

```
OpenClaw  ──(OpenAI API)──►  geminicli-bridge (:18791)  ──►  gemini --prompt --output-format stream-json
```

### Key Benefits

- **🆓 Zero API Cost** — Uses Gemini CLI's free tier (Google OAuth authentication)
- **🧠 Gemini 3 Pro** — Access to `gemini-3-pro-preview` and other cutting-edge models
- **🔄 Streaming Support** — Real-time token streaming via SSE
- **🔌 Zero Dependencies** — Pure Node.js, no npm packages needed
- **🛡️ Safe by Default** — Uses `plan` mode (read-only) by default
- **📡 OpenAI-Compatible** — Drop-in replacement for any OpenAI API consumer

## 📋 Prerequisites

- **Node.js** >= 22
- **Gemini CLI** installed and authenticated
- **OpenClaw** (optional, any OpenAI-compatible client works)

## 🚀 Quick Start

### 1. Install Gemini CLI

```bash
npm install -g @anthropic-ai/gemini-cli
```

### 2. Authenticate Gemini CLI

```bash
gemini
# Follow the prompts to authenticate with Google OAuth
# Verify: gemini --prompt "say hello" --output-format json
```

### 3. Clone and Start the Bridge

```bash
git clone https://github.com/Kinolian1107/geminicli-bridge.git
cd geminicli-bridge

# Copy and edit config (optional)
cp .env.example .env

# Start in foreground
bash start.sh

# Or start in background (daemon mode)
bash start.sh daemon
```

### 4. Configure OpenClaw

Add a new provider to your `~/.openclaw/openclaw.json`:

```json
{
  "models": {
    "providers": {
      "geminicli": {
        "baseUrl": "http://127.0.0.1:18791/v1",
        "apiKey": "geminicli-bridge-local",
        "api": "openai-completions",
        "models": [
          {
            "id": "gemini/gemini-3-pro-preview",
            "name": "Gemini 3 Pro Preview via Gemini CLI",
            "reasoning": true,
            "input": ["text"],
            "cost": {
              "input": 0,
              "output": 0,
              "cacheRead": 0,
              "cacheWrite": 0
            },
            "contextWindow": 1000000,
            "maxTokens": 65536
          }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "geminicli/gemini/gemini-3-pro-preview"
      }
    }
  }
}
```

### 5. Verify

```bash
# Test health
curl http://127.0.0.1:18791/health

# Test models endpoint
curl http://127.0.0.1:18791/v1/models

# Test chat completion
curl -X POST http://127.0.0.1:18791/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini/gemini-3-pro-preview",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'
```

## ⚙️ Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BRIDGE_PORT` | `18791` | Port for the bridge server |
| `BRIDGE_HOST` | `127.0.0.1` | Host to bind to |
| `GEMINI_MODEL` | `gemini-3-pro-preview` | Gemini model to use |
| `GEMINI_BIN` | `gemini` | Path to gemini CLI binary |
| `GEMINI_APPROVAL_MODE` | `plan` | Tool approval mode (see below) |
| `GEMINI_WORKING_DIR` | `$HOME` | Working directory for Gemini CLI |
| `BRIDGE_TIMEOUT_MS` | `300000` | Request timeout (ms) |
| `BRIDGE_MAX_ARG_LEN` | `32768` | Max prompt length before stdin pipe |

### Approval Modes

| Mode | Description | Safety |
|------|-------------|--------|
| `plan` | Read-only, no file changes or commands | ✅ Safest (default) |
| `default` | Prompt for approval on each action | ⚠️ Interactive |
| `auto_edit` | Auto-approve file edits, prompt for commands | ⚠️ Medium |
| `yolo` | Auto-approve everything | ❌ Use with caution |

### Available Models

Run `gemini --model` to see all available models. Common choices:

| Model | Description |
|-------|-------------|
| `gemini-3-pro-preview` | 🌟 Gemini 3 Pro Preview (recommended) |
| `gemini-3-flash-preview` | ⚡ Gemini 3 Flash Preview (faster) |
| `gemini-2.5-pro` | Gemini 2.5 Pro |
| `gemini-2.5-flash` | Gemini 2.5 Flash |

## 🔧 API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/v1/models` | GET | List available models |
| `/v1/chat/completions` | POST | Chat completion (streaming & non-streaming) |

## 🏗️ Architecture

### How It Works

1. **OpenClaw** sends an OpenAI-compatible chat completion request
2. **geminicli-bridge** converts the messages array into a single prompt
3. **Gemini CLI** is invoked in headless mode:
   - Streaming: `gemini --prompt "..." --output-format stream-json --model gemini-3-pro-preview --approval-mode plan`
   - Non-streaming: `gemini --prompt "..." --output-format json --model gemini-3-pro-preview --approval-mode plan`
4. **Stream-JSON events** (init, message, tool_use, tool_result, result) are parsed and converted to SSE chunks
5. **Token usage** is extracted from Gemini CLI's stats output

### Differences from cursor-bridge

| Feature | cursor-bridge | geminicli-bridge |
|---------|--------------|-----------------|
| Backend CLI | `cursor-agent` | `gemini` |
| Auth | Cursor Pro subscription | Google OAuth (free) |
| Output format | `--stream-json` (cursor-specific) | `--output-format stream-json` |
| Tool handling | Native tool injection into prompt | Gemini CLI handles tools internally |
| Approval mode | Mode flag on cursor-agent | `--approval-mode` flag |
| Default port | 18790 | 18791 |
| Cost | Cursor Pro/Business subscription | Free (with rate limits) |

## 🛑 Stopping

```bash
bash stop.sh
```

## 📊 Logging

Check the log file for request details:

```bash
# View recent logs
tail -f geminicli-bridge.log

# Example log output:
# [2026-02-17T...] → Request abc12345: model=gemini-3-pro-preview stream=true prompt=1234 chars (arg)
# [2026-02-17T...] ✓ Request abc12345: completed in 5.2s (stream, 456 chars)
```

## 🔗 Related Projects

- [OpenClaw](https://github.com/openclaw/openclaw) — Personal AI assistant
- [Gemini CLI](https://github.com/google-gemini/gemini-cli) — Google's AI agent for the terminal
- [cursor-bridge](https://github.com/nicobailon/openclaw-bridge-cursorcli) — Similar bridge for Cursor CLI

## 📜 License

[MIT](LICENSE)
