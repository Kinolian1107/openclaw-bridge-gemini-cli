# 🌉 geminicli-bridge

> OpenAI 相容的 API 代理伺服器，將 [OpenClaw](https://github.com/openclaw/openclaw) 橋接至 [Gemini CLI](https://github.com/google-gemini/gemini-cli)，讓你可以免費使用 Google 的 Gemini 模型作為 OpenClaw 的 AI Provider。

## ✨ 為什麼需要這個？

[OpenClaw](https://github.com/openclaw/openclaw) 是一個強大的個人 AI 助手，支援多種 AI Provider。[Gemini CLI](https://geminicli.com) 提供了對 Google Gemini 模型的免費存取（包括 Gemini 3 Pro），具有優渥的使用額度。

**geminicli-bridge** 連接兩者：運行一個本地 HTTP 伺服器，接受來自 OpenClaw 的 OpenAI 相容 API 請求，並將其轉換為 Gemini CLI headless 模式的呼叫。

```
OpenClaw  ──(OpenAI API)──►  geminicli-bridge (:18791)  ──►  gemini --prompt --output-format stream-json
```

### 主要優勢

- **🆓 零 API 費用** — 使用 Gemini CLI 的免費層（Google OAuth 認證）
- **🧠 Gemini 3 Pro** — 存取 `gemini-3-pro-preview` 等最新模型
- **🔄 串流支援** — 透過 SSE 即時串流 token
- **🔌 零依賴** — 純 Node.js，不需要任何 npm 套件
- **🛡️ 預設安全** — 預設使用 `plan` 模式（唯讀）
- **📡 OpenAI 相容** — 可直接替換任何 OpenAI API 使用方

## 📋 前置需求

- **Node.js** >= 22
- **Gemini CLI** 已安裝且已認證
- **OpenClaw**（選用，任何 OpenAI 相容的客戶端皆可）

## 🚀 快速開始

### 1. 安裝 Gemini CLI

```bash
npm install -g @anthropic-ai/gemini-cli
```

### 2. 認證 Gemini CLI

```bash
gemini
# 依照提示使用 Google OAuth 認證
# 驗證: gemini --prompt "say hello" --output-format json
```

### 3. Clone 並啟動 Bridge

```bash
git clone https://github.com/Kinolian1107/geminicli-bridge.git
cd geminicli-bridge

# 複製並編輯設定（選用）
cp .env.example .env

# 前景啟動
bash start.sh

# 背景啟動（daemon 模式）
bash start.sh daemon
```

### 4. 設定 OpenClaw

在 `~/.openclaw/openclaw.json` 中新增 provider：

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

### 5. 驗證

```bash
# 測試健康檢查
curl http://127.0.0.1:18791/health

# 測試聊天完成（非串流）
curl -X POST http://127.0.0.1:18791/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini/gemini-3-pro-preview",
    "messages": [{"role": "user", "content": "你好！"}],
    "stream": false
  }'
```

## ⚙️ 設定

### 環境變數

| 變數 | 預設 | 說明 |
|------|------|------|
| `BRIDGE_PORT` | `18791` | Bridge 伺服器連接埠 |
| `GEMINI_MODEL` | `gemini-3-pro-preview` | 使用的 Gemini 模型 |
| `GEMINI_APPROVAL_MODE` | `plan` | 工具核准模式 |
| `GEMINI_WORKING_DIR` | `$HOME` | Gemini CLI 工作目錄 |
| `BRIDGE_TIMEOUT_MS` | `300000` | 請求逾時 (毫秒) |

### 核准模式

| 模式 | 說明 | 安全性 |
|------|------|--------|
| `plan` | 唯讀，不修改檔案也不執行命令 | ✅ 最安全（預設） |
| `default` | 每次動作前詢問核准 | ⚠️ 互動式 |
| `auto_edit` | 自動核准檔案編輯，命令需詢問 | ⚠️ 中等 |
| `yolo` | 自動核准所有動作 | ❌ 謹慎使用 |

## 🛑 停止

```bash
bash stop.sh
```

## 🔗 相關專案

- [OpenClaw](https://github.com/openclaw/openclaw) — 個人 AI 助手
- [Gemini CLI](https://github.com/google-gemini/gemini-cli) — Google 的終端機 AI 代理
- [cursor-bridge](https://github.com/nicobailon/openclaw-bridge-cursorcli) — 類似的 Cursor CLI 橋接

## 📜 授權

[MIT](LICENSE)
