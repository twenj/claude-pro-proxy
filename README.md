# Claude OpenAI-compatible proxy

This project exposes a small subset of the OpenAI API and forwards requests to Claude.

## Run with the Anthropic API

```bash
cp .env.example .env
npm start
```

Set `ANTHROPIC_API_KEY` in `.env`. This mode supports native Anthropic tool use and true SSE streaming.

## Run with Claude CLI

```bash
npm run start:cli
```

The CLI mode uses the local Claude login. OpenAI tool calls are emulated through structured prompting because Claude CLI does not accept external function schemas as native tools. Built-in CLI tools are disabled, except read-only access to temporary uploaded image files.

With `stream: true`, plain-text replies are forwarded to the client as they arrive. A reply is held back and buffered only while it still looks like it could turn into a ` ```json {"tool_calls": ...} ``` ` block, so structured tool calls are never leaked to the client as partial JSON.

### Token usage

- The tool-calling instructions (including the `ask_user_question` affordance) are only added to the system prompt when the request actually includes `tools`; plain chat requests never pay for that boilerplate.
- If a request's `messages` array is exactly the previous response's messages plus one new turn, the proxy resumes the underlying Claude CLI session (`--resume`) and only sends the new turn, instead of re-sending the full conversation history every time. This falls back transparently to a full rebuild whenever that isn't possible (first turn, edited history, an expired/evicted session, etc.), so it's a pure optimization and never a source of failures.

### User clarification tool

CLI mode exposes a proxy-level OpenAI function named `ask_user_question`. When Claude needs a blocking choice, the response has `finish_reason: "tool_calls"` and arguments shaped like:

```json
{
  "question": "Which environment should be updated?",
  "options": [
    { "label": "Development", "description": "Update local development only." },
    { "label": "Production", "description": "Prepare the production configuration." }
  ]
}
```

The frontend should render these options and send the selected value in the next request as an OpenAI `role: "tool"` message using the returned `tool_call_id`. The proxy then passes that result back to Claude so it can continue.

## Configuration

- `PORT`: listening port (`3000` for SDK mode, `3001` for CLI mode)
- `DEFAULT_MODEL`: defaults to `claude-sonnet-4-6`
- `PROXY_API_KEY`: optional bearer token required by every endpoint
- `ALLOWED_ORIGINS`: comma-separated CORS allowlist; empty allows all origins
- `BODY_LIMIT`: Express request limit, default `10mb`
- `CLAUDE_BIN`: Claude executable path for CLI mode
- `CLI_TIMEOUT_MS`: CLI mode only; kills the Claude CLI process if it hasn't finished within this many milliseconds (default `120000`)

Do not expose the service publicly without setting `PROXY_API_KEY` and `ALLOWED_ORIGINS`.
