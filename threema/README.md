# Threema extension for pi

A pi extension that lets the agent:

- send outbound Threema text messages with the `threema_send` tool
- receive inbound Threema Gateway webhook messages
- verify the webhook MAC
- decrypt inbound end-to-end encrypted Threema text messages
- inject allowed inbound messages into the current pi conversation

## What it does

Outbound messages are sent through the Threema Gateway **Simple Mode** API.

Inbound messages are accepted through a local webhook server, validated with the Gateway MAC, decrypted with your Threema private key, and then delivered to pi as user messages.

Currently, inbound **text messages** are supported.

## Security model

By default, inbound messages are only accepted from `THREEMA_RECIPIENT_ID`.

You can override this with `THREEMA_ALLOWED_SENDERS`, a comma-separated allowlist of Threema IDs. Any sender not in that allowlist is rejected.

Duplicate webhook deliveries are deduplicated by message ID and stored in a small local cache so they can still be rejected after reloads and restarts.

## Requirements

- pi installed and working
- a Threema Gateway ID
- your Threema Gateway API secret
- your Threema private key for inbound message decryption
- a publicly reachable callback URL for the webhook endpoint
- Node.js 22+ if you want to run the included tests with `npm test`

## Files

- `index.ts` – pi extension entry point
- `lib.ts` – crypto and helper functions
- `threema.example.json` – JSON configuration template
- `.env.example` – legacy environment template
- `test.ts` – unit tests

## Installation

### Option 1: quick test with `--extension`

Run pi and point it directly at the extension entry file:

```bash
pi -e /absolute/path/to/threema/index.ts
```

This is the fastest way to try it locally.

### Option 2: install as a normal pi extension

Copy or symlink the `threema/` folder into one of pi's extension locations:

- global: `~/.pi/agent/extensions/pi-threema/`
- project-local: `.pi/extensions/pi-threema/`

Example:

```bash
mkdir -p ~/.pi/agent/extensions
cp -R /absolute/path/to/threema ~/.pi/agent/extensions/pi-threema
```

Then start pi normally. If pi is already running, use:

```text
/reload
```

## Configuration

Create a private JSON config file at the default location `~/.pi/agent/extensions/pi-threema/threema.json`:

```bash
mkdir -p ~/.pi/agent/extensions/pi-threema
chmod 700 ~/.pi/agent ~/.pi/agent/extensions ~/.pi/agent/extensions/pi-threema
cp /absolute/path/to/threema/threema.example.json ~/.pi/agent/extensions/pi-threema/threema.json
chmod 600 ~/.pi/agent/extensions/pi-threema/threema.json
```

Then edit `~/.pi/agent/extensions/pi-threema/threema.json`:

```json
{
  "apiId": "*MYAPID",
  "apiSecret": "your_api_secret_here",
  "privateKey": "0000000000000000000000000000000000000000000000000000000000000000",
  "recipientId": "ABCD1234",
  "allowedSenders": ["ABCD1234"],
  "webhookPort": 7633
}
```

### JSON config fields

Required:

- `apiId` – your 8-character Threema Gateway ID
- `apiSecret` – your Gateway API secret; used for outbound API calls and inbound webhook MAC verification
- `privateKey` – 32-byte private key as 64 hex characters; used to decrypt inbound messages
- `recipientId` – default outbound recipient and the default inbound allowlist entry

Optional:

- `allowedSenders` – inbound sender allowlist as an array of Threema IDs, or a comma-separated string. If omitted, the extension only accepts inbound messages from `recipientId`.
- `webhookPort` – local HTTP port for `/webhook` and `/health`. If omitted, the extension defaults to `7633`.

Environment overrides:

- `THREEMA_CONFIG_PATH` – optional path to a different JSON config file.
- `PI_CODING_AGENT_DIR` – optional. If set, the default config path becomes `$PI_CODING_AGENT_DIR/extensions/pi-threema/threema.json`, and the duplicate-message cache is stored under `$PI_CODING_AGENT_DIR`.

Legacy environment-variable config is still supported if no JSON config file exists.

The callback URL itself is **not** read from an environment variable. You configure that separately in the Threema Gateway console and point it at `http://<your-host>:<port>/webhook`.

## Starting pi

After creating `~/.pi/agent/extensions/pi-threema/threema.json`, start pi normally:

```bash
pi -e /absolute/path/to/threema/index.ts
```

Or, if you installed the extension into a discovered pi extension directory:

```bash
pi
```

## Webhook setup

The extension starts an HTTP server on `THREEMA_WEBHOOK_PORT`.

Endpoints:

- `GET /health` → returns `ok`
- `POST /webhook` → receives Threema Gateway callbacks

Configure your Threema Gateway callback URL as:

```text
http://<your-host>:7633/webhook
```

Replace:

- `<your-host>` with a host reachable by Threema Gateway
- `7633` with your configured `THREEMA_WEBHOOK_PORT`

If pi is running on a machine behind NAT, you will need a tunnel, reverse proxy, VPN, or other way to expose the webhook endpoint.

## Usage

### Outbound messages

Once the extension is loaded, the agent can call the `threema_send` tool.

Typical uses:

- send task completion notifications
- ask concise follow-up questions
- send short summaries while you're away from the terminal

The tool parameters are:

- `message` – required text
- `recipient` – optional Threema ID; defaults to `THREEMA_RECIPIENT_ID`

### Inbound messages

When an allowed sender sends a Threema message to your Gateway ID:

1. Threema Gateway calls your webhook
2. the extension verifies the MAC
3. the extension checks the sender allowlist
4. the extension decrypts the message
5. the message is injected into pi as a user message

If pi is already busy, the inbound message is queued as a follow-up message instead of causing an error.

### Status command

Inside pi, run:

```text
/threema
```

This shows:

- configured API ID
- default recipient
- allowed senders
- webhook port and URL template
- credit count if available
- whether the webhook server is running

## Running tests

From the `threema/` directory:

```bash
npm test
```

This uses Node's TypeScript stripping support to run `test.ts` directly.

## Notes and limitations

- inbound support is currently limited to **text** messages
- outbound messages use Gateway **Simple Mode**, not end-to-end encryption
- inbound webhook duplicates are deduplicated and stored in a small local cache
- the webhook server must be reachable from Threema Gateway

## Troubleshooting

### The extension says it is disabled

Make sure all required environment variables are exported, then run:

```text
/reload
```

### Inbound messages are rejected

Check:

- the callback URL is reachable
- `THREEMA_API_SECRET` is correct
- `THREEMA_PRIVATE_KEY` is correct
- the sender is included in `THREEMA_ALLOWED_SENDERS`
- the webhook is targeting the correct Gateway ID

### The webhook server does not receive requests

Check:

- local firewall rules
- router/NAT forwarding
- reverse proxy or tunnel configuration
- `THREEMA_WEBHOOK_PORT`

### The agent does not respond to inbound messages

Check pi is running with a valid model/provider configured and that the extension is loaded.
