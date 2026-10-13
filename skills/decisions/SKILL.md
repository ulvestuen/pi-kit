---
name: decisions
description: Evaluates inputs with TypeSafe's JEV API or OpenAI's Decisions API. Use for classification, routing, yes/no probabilities, or rubric-based scoring, not text generation.
---

# Decisions

```diagram
┌──────────────────────┐     ┌───────────────┐     ┌────────────────────────┐
│ Provider + native    │────▶│ decisions.mjs │────▶│ jev: /v1/systemone     │
│ request + env key    │     └───────────────┘     │ openai: /v1/decisions  │
└──────────────────────┘                           └───────────┬────────────┘
                                                             ▼
                                                  Native answers + usage
```

Both APIs return typed decisions, not prose or chat completions. Run the bundled
zero-dependency helper with Node.js 18+; no SDK installation is needed.

## Configuration

| Provider | Required environment | Endpoint | Default model |
| --- | --- | --- | --- |
| `jev` | `TYPESAFE_API_KEY` | `https://api.typesafe.ai/v1/systemone` | `jev-latest` |
| `openai` | `OPENAI_API_KEY` | `https://api.openai.com/v1/decisions` | `gpt-6-luna` |

Optional `DECISIONS_PROVIDER=jev|openai` sets a preferred provider. Only the
selected provider's key is required. The environment doctor reports key
presence for each provider separately; it does not select a provider.

The helper sends JSON with `POST` and `Authorization: Bearer <key>` only to
the selected official endpoint. It does not follow redirects or use proxies
such as third-party services branded "Decisions API".

## Choose the provider first

Before constructing request JSON, resolve the provider in this order:

1. Use the user's explicit choice (`jev` for TypeSafe/JEV, `openai` for OpenAI).
2. Otherwise use `DECISIONS_PROVIDER`, if set to `jev` or `openai`.
3. Otherwise, if exactly one API key is configured, use its provider.
4. If both keys are configured with no preference, ask the user which to use.
   If neither is configured, ask them to configure one; do not attempt a request.

Run the local selector rather than printing or inspecting key values:

```sh
# No explicit user preference: resolve the environment default or sole key.
node {baseDir}/decisions.mjs provider

# The user explicitly requested OpenAI: override any environment preference.
node {baseDir}/decisions.mjs provider openai
```

The selector makes no network calls. On success it prints only `jev` or
`openai`; use that result as the first argument when making the request below.
On an error, stop and ask for the indicated choice or configuration. Do not
invent an explicit choice to bypass ambiguity. An invalid default or a missing
key for the chosen provider is an error, not permission to use the other provider.
After the user answers, rerun the selector with their choice; do not persist a
default unless asked.

This chooses the API inside this skill, not another skill to load. Respect the
user's data-sharing restrictions regardless of key availability. Image evaluation
requires OpenAI: if selection yields JEV, ask before switching; do not silently
drop images or substitute a text description. Never switch providers after an
API failure. The request command remains explicit so the provider cannot change
after you have built its native JSON.

## Make a request

Run `node {baseDir}/decisions.mjs <jev | openai> <request.json | ->`.
Pass a JSON file, or `-` for stdin. Set `model` in the JSON to override the
provider default with a documented model ID.

The concepts are similar, but the APIs are **not wire-compatible**. The helper
checks the request envelope, then passes through native fields and returns
the full native response; it does not translate schemas or normalize answers.

| Concept | JEV | OpenAI Decisions |
| --- | --- | --- |
| Evidence | `state`: string, object, or array | `input`: string or user messages with text/image parts |
| Questions / answers | Maps keyed by question ID | Arrays; give questions unique `name` values, echoed in answers |
| Yes/no | `type: "noul"`; optional `criteria.true` / `criteria.false`; answer `noul` | `type: "predicate"`; criteria go in `instructions`; answer `probability` |
| Choice | `criteria` map of option names to descriptions (or `null`) | `choices` array of `{value, description?}`; values are strings or booleans |
| Score | `criteria` array of ordered descriptions | `levels` array of `{label, description?}` |
| Distribution | `probabilities` map; scores also have `legend` | `probabilities` array of `{value, probability}`; scores also include `label` |

### JEV

```sh
node {baseDir}/decisions.mjs jev - <<'JSON'
{
  "state": "I was charged twice yesterday. Please refund the duplicate payment.",
  "questions": {
    "urgent": {
      "type": "noul",
      "instructions": "Does the customer explicitly need immediate action?",
      "criteria": {"true": "Explicit time pressure", "false": "No immediate deadline"}
    },
    "team": {
      "type": "choice",
      "instructions": "Which team should handle this request?",
      "criteria": {"billing": "Payments and refunds", "technical": "Bugs and outages", "other": "Neither"}
    },
    "frustration": {
      "type": "score",
      "instructions": "How frustrated is the customer?",
      "criteria": ["Calm", "Frustrated", "Very angry"]
    }
  }
}
JSON
```

JEV accepts structured `state`, `instructions`, and criteria. Question IDs
are not sent to its model; put the full question in `instructions`. Choice
supports up to 255 options; Score accepts 2–10 levels.

### OpenAI

```sh
node {baseDir}/decisions.mjs openai - <<'JSON'
{
  "input": "I was charged twice yesterday. Please refund the duplicate payment.",
  "questions": [
    {
      "type": "predicate",
      "name": "urgent",
      "instructions": "Does the customer explicitly need immediate action? Require explicit time pressure, not just a refund request."
    },
    {
      "type": "choice",
      "name": "team",
      "instructions": "Which team should handle this request?",
      "choices": [
        {"value": "billing", "description": "Payments and refunds"},
        {"value": "technical", "description": "Bugs and outages"},
        {"value": "other", "description": "Neither"}
      ]
    },
    {
      "type": "score",
      "name": "frustration",
      "instructions": "How frustrated is the customer?",
      "levels": [{"label": "Calm"}, {"label": "Frustrated"}, {"label": "Very angry"}]
    }
  ]
}
JSON

node {baseDir}/decisions.mjs openai /tmp/decision-request.json
```

OpenAI requires string `instructions`. Serialize structured evidence to a
text string rather than passing an arbitrary object as `input`. For images,
use `input: [{"role":"user","content":[{"type":"input_text","text":"Inspect this"},
{"type":"input_image","image_url":"data:image/png;base64,..."}]}]`, replacing
the placeholder with real base64. No `file_id` inputs. The guide and reference
currently disagree on hosted image URLs; use inline data URLs for portability.
Choice accepts 2–255 unique values; boolean `true` and string `"true"` are distinct.

## Interpret answers

Batch independent questions about the same evidence; use separate requests
when a question depends on an earlier answer. For OpenAI, check each answer's
`type` for `refusal` before reading its result; a refusal is not false or zero,
and other questions in the same response may still have answers.

Noul `noul` and predicate `probability` are 0–1 probabilities, **not booleans**.
Scores are probability-weighted, zero-based level indices and may be fractional:
three levels span 0–2, not 0–1. Both providers return Choice/Score `confidence`
separately from probabilities; do not assume it equals the selected option's
probability or that thresholds transfer across providers. Calibrate thresholds
on labeled examples and keep uncertainty visible. Output includes `model` and `usage`.

## Safety and errors

- If the key is missing, ask the user to configure it in their environment;
  never ask them to paste it into chat or put it in command arguments/files.
- Only send data authorized for the selected provider. Exclude credentials
  and unnecessary personal data from evidence and questions.
- API decisions do not authorize actions. Confirm consequential external
  changes unless the user already requested those specific changes.
- The helper times out after 30 seconds, exits nonzero on errors, and does
  not retry automatically. For `401`, check key configuration without
  revealing it; for `400`/`422`, correct the indicated request fields. For
  rate limits or transient overload, honor `Retry-After` if present and use
  bounded exponential backoff (at most three retries). Do not retry exhausted
  quota or other permanent errors, and never switch providers on failure.
- Never enable request/header debug logging or print the API key.

Authoritative references: TypeSafe [API](https://docs.typesafe.ai/api),
[models](https://docs.typesafe.ai/models), and [confidence](https://docs.typesafe.ai/confidence);
OpenAI [guide](https://developers.openai.com/api/docs/guides/decisions) and
[API reference](https://developers.openai.com/api/reference/resources/decisions/methods/create).
