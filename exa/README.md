# Exa web search extension for pi

A pi extension that gives the agent live web search through [Exa](https://exa.ai).

## What it does

Registers an `exa_search` tool that queries the Exa `/search` endpoint and
returns ranked results — title, URL, publish date, author, and page text (or
highlights/summary when available). Use it to look up current information,
documentation, news, or anything outside the model's training data.

It also injects a short note into the system prompt so the agent knows the
search tool exists, and adds an `/exa` status command.

## Requirements

- pi installed and working
- an Exa API key — create one at <https://dashboard.exa.ai/api-keys>
- Node.js 22+ if you want to run the included tests with `npm test`

## Files

- `index.ts` – pi extension entry point
- `config.ts` – configuration loading and validation
- `search.ts` – Exa request building, result formatting, and API call
- `exa.example.json` – JSON configuration template
- `.env.example` – environment-variable template
- `test.ts` – unit tests

## Installation

The extension lives in the `exa/` subfolder of the [pi-kit](https://github.com/ulvestuen/pi-kit/)
repository. The repository root carries a `pi-package` manifest that exposes
`./exa` as an extension, so pi can install it directly from GitHub.

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
pi -e /absolute/path/to/pi-kit/exa/index.ts
```

### Option 3: install by copying

Copy or symlink the `exa/` folder into one of pi's extension locations:

- global: `~/.pi/agent/extensions/pi-exa/`
- project-local: `.pi/extensions/pi-exa/`

```bash
git clone https://github.com/ulvestuen/pi-kit.git
mkdir -p ~/.pi/agent/extensions
cp -R pi-kit/exa ~/.pi/agent/extensions/pi-exa
```

If pi is already running, reload with `/reload`.

## Configuration

The extension reads its config from a private JSON file, falling back to
environment variables if no file is found. This matches the other extensions
in this repo.

### JSON config file (recommended)

Create a private JSON config at the default location
`~/.pi/agent/extensions/pi-exa/exa.json`:

```bash
mkdir -p ~/.pi/agent/extensions/pi-exa
chmod 700 ~/.pi/agent ~/.pi/agent/extensions ~/.pi/agent/extensions/pi-exa
cp /absolute/path/to/exa/exa.example.json ~/.pi/agent/extensions/pi-exa/exa.json
chmod 600 ~/.pi/agent/extensions/pi-exa/exa.json
```

Then edit it:

```json
{
  "apiKey": "your_exa_api_key_here",
  "baseUrl": "https://api.exa.ai",
  "numResults": 5,
  "searchType": "auto",
  "includeText": true,
  "maxCharacters": 1000
}
```

### Config fields

Required:

- `apiKey` – your Exa API key.

Optional:

- `baseUrl` – Exa API base URL (default `https://api.exa.ai`).
- `numResults` – default number of results, 1–100 (default `5`). Each call can override this.
- `searchType` – one of `auto`, `neural`, `keyword`, `fast`, `deep`, `deep-reasoning`, `instant` (default `auto`).
- `includeText` – whether to fetch page text contents with each result (default `true`).
- `maxCharacters` – cap on page text per result; `0` means uncapped (default `1000`).
- `category` – optional default category filter, e.g. `news`, `research paper`, `github`, `company`, `pdf`.

### Environment variables

If no JSON config file exists, the extension reads these instead:

- `EXA_API_KEY` (required)
- `EXA_BASE_URL`
- `EXA_NUM_RESULTS`
- `EXA_SEARCH_TYPE`
- `EXA_INCLUDE_TEXT`
- `EXA_MAX_CHARACTERS`
- `EXA_CATEGORY`
- `EXA_CONFIG_PATH` – path to a different JSON config file.
- `PI_CODING_AGENT_DIR` – if set, the default config path becomes `$PI_CODING_AGENT_DIR/extensions/pi-exa/exa.json`.

See `.env.example` for a copy-paste template.

## Usage

Once loaded, the agent can call the `exa_search` tool. Parameters:

- `query` – required search query
- `numResults` – optional override of the configured default
- `category` – optional category filter
- `includeDomains` / `excludeDomains` – optional domain allow/deny lists
- `startPublishedDate` / `endPublishedDate` – optional ISO 8601 date bounds

### Status command

Inside pi, run `/exa` to see the configured base URL, search type, result
count, text settings, and a masked API key.

## Running tests

From the `exa/` directory:

```bash
npm test
```

This runs `test.ts` directly via `tsx`. The tests cover config parsing,
request building, and result formatting; they do not make network calls.

## Troubleshooting

### The extension says it is disabled

Make sure `apiKey` is set in the JSON config (or `EXA_API_KEY` is exported),
then run `/reload`.

### Exa API errors

A `401`/`403` usually means the API key is wrong or out of credits. Check your
key and usage at <https://dashboard.exa.ai>.
