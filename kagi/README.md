# Kagi web search extension for pi

A pi extension that gives the agent live web search through [Kagi](https://kagi.com).

## What it does

Registers a `kagi_search` tool that queries the Kagi
[Search API](https://help.kagi.com/kagi/api/search.html) and returns ranked
results — title, URL, publish date, and snippet. Use it to look up current
information, documentation, news, or anything outside the model's training data.

It also injects a short note into the system prompt so the agent knows the
search tool exists, and adds a `/kagi` status command.

## Requirements

- pi installed and working
- a Kagi API token — create one at <https://kagi.com/settings?p=api>
  (the Search API requires API access to be enabled on your account)
- Node.js 22+ if you want to run the included tests with `npm test`

## Files

- `index.ts` – pi extension entry point
- `config.ts` – configuration loading and validation
- `search.ts` – Kagi request building, result formatting, and API call
- `kagi.example.json` – JSON configuration template
- `.env.example` – environment-variable template
- `test.ts` – unit tests

## Installation

The extension lives in the `kagi/` subfolder of the [pi-kit](https://github.com/ulvestuen/pi-kit/)
repository. The repository root carries a `pi-package` manifest that exposes
`./kagi` as an extension, so pi can install it directly from GitHub.

### Option 1: install as a pi package from GitHub (recommended)

```bash
pi install https://github.com/ulvestuen/pi-kit
```

Pin to a tag, branch, or commit using the `@<ref>` suffix:

```bash
pi install git:github.com/ulvestuen/pi-kit@main
```

### Option 2: quick test with `--extension`

```bash
git clone https://github.com/ulvestuen/pi-kit.git
pi -e /absolute/path/to/pi-kit/kagi/index.ts
```

### Option 3: install by copying

Copy or symlink the `kagi/` folder into one of pi's extension locations:

- global: `~/.pi/agent/extensions/pi-kagi/`
- project-local: `.pi/extensions/pi-kagi/`

```bash
git clone https://github.com/ulvestuen/pi-kit.git
mkdir -p ~/.pi/agent/extensions
cp -R pi-kit/kagi ~/.pi/agent/extensions/pi-kagi
```

If pi is already running, reload with `/reload`.

## Configuration

The extension reads its config from a private JSON file, falling back to
environment variables if no file is found. This matches the other extensions
in this repo.

### JSON config file (recommended)

Create a private JSON config at the default location
`~/.pi/agent/extensions/pi-kagi/kagi.json`:

```bash
mkdir -p ~/.pi/agent/extensions/pi-kagi
chmod 700 ~/.pi/agent ~/.pi/agent/extensions ~/.pi/agent/extensions/pi-kagi
cp /absolute/path/to/kagi/kagi.example.json ~/.pi/agent/extensions/pi-kagi/kagi.json
chmod 600 ~/.pi/agent/extensions/pi-kagi/kagi.json
```

Then edit it:

```json
{
  "apiKey": "your_kagi_api_token_here",
  "baseUrl": "https://kagi.com/api/v0",
  "limit": 10,
  "includeRelated": false
}
```

### Config fields

Required:

- `apiKey` – your Kagi API token.

Optional:

- `baseUrl` – Kagi API base URL (default `https://kagi.com/api/v0`).
- `limit` – default number of results, 1–100 (default `10`). Each call can override this.
- `includeRelated` – whether to append Kagi's "related searches" suggestions to the output (default `false`).

### Environment variables

If no JSON config file exists, the extension reads these instead:

- `KAGI_API_KEY` (required)
- `KAGI_BASE_URL`
- `KAGI_LIMIT`
- `KAGI_INCLUDE_RELATED`
- `KAGI_CONFIG_PATH` – path to a different JSON config file.
- `PI_CODING_AGENT_DIR` – if set, the default config path becomes `$PI_CODING_AGENT_DIR/extensions/pi-kagi/kagi.json`.

See `.env.example` for a copy-paste template.

## Usage

Once loaded, the agent can call the `kagi_search` tool. Parameters:

- `query` – required search query
- `limit` – optional override of the configured default

### Status command

Inside pi, run `/kagi` to see the configured base URL, result limit, related
search setting, and a masked API key.

## Running tests

From the `kagi/` directory:

```bash
npm test
```

This runs `test.ts` directly via `tsx`. The tests cover config parsing,
request building, and result formatting; they do not make network calls.

## Troubleshooting

### The extension says it is disabled

Make sure `apiKey` is set in the JSON config (or `KAGI_API_KEY` is exported),
then run `/reload`.

### Kagi API errors

A `401`/`403` usually means the API token is wrong or API access is not enabled
on your account. Check your token and usage at <https://kagi.com/settings?p=api>.
The Search API also consumes API credits per query, so a billing-related error
may mean your balance is exhausted.
