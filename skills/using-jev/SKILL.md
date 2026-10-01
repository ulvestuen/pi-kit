---
name: using-jev
description: Evaluates text or structured data with TypeSafe's JEV API using TYPESAFE_API_KEY. Use for JEV API requests, classification, routing, yes/no judgments, or rubric-based scoring, not text generation.
---

# Using JEV

```diagram
┌──────────────────┐     ┌─────────┐     ┌────────────────────────┐
│ TYPESAFE_API_KEY │────▶│ jev.mjs │────▶│ TypeSafe /v1/systemone │
│ state + questions│     └─────────┘     └────────────┬───────────┘
└──────────────────┘                                 ▼
                                          Typed answers + usage
```

JEV makes typed decisions, not prose or chat completions. Run the bundled
zero-dependency helper with Node.js 18+; no SDK installation is needed.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | yes | TypeSafe API key; read from the environment, never print it |

The helper sends `POST https://api.typesafe.ai/v1/systemone` with
`Authorization: Bearer <key>` and `Content-Type: application/json`. It does
not follow redirects or send the key to a proxy or third-party JEV service.

## Make a request

Pass a JSON file, or `-` to read JSON from stdin. The helper defaults `model`
to `jev-latest`; specify a documented model version in the JSON to pin it.

```sh
node {baseDir}/jev.mjs - <<'JSON'
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

node {baseDir}/jev.mjs /tmp/jev-request.json
```

`state` accepts a string, object, or array. Include only the context needed
for the decision. Batch independent questions about the same state in one
`questions` map. Question IDs only associate answers with questions; they are
not sent to the model, so put the full question in `instructions`.

| Type | Request `criteria` | Read from `answers.<question id>` |
| --- | --- | --- |
| `noul` | Optional `true`/`false` descriptions | `noul`: probability of yes, 0–1; **not a boolean** |
| `choice` | Map of option names to descriptions (or `null`), up to 255 options | `choice`, `probabilities`, `confidence` |
| `score` | Ordered array of 2–10 level descriptions | `score`, `legend`, `probabilities`, `confidence` |

Scores are probability-weighted, zero-based level indices and may be
fractional: three levels span 0–2, not 0–1. Choice/Score `confidence` is not
the selected option's probability. Keep uncertainty visible and choose
application-specific thresholds deliberately; never treat a nonzero Noul
value as an automatic yes. The JSON output also includes `model` and `usage`.

## Safety and errors

- If the key is missing, ask the user to configure it in their environment;
  never ask them to paste it into chat or put it in command arguments/files.
- Only send data the user has authorized sharing with TypeSafe. Exclude
  credentials and unnecessary personal data from `state` and questions.
- API decisions do not authorize actions. Confirm consequential external
  changes unless the user already requested those specific changes.
- The helper times out after 30 seconds, exits nonzero on errors, and does
  not retry automatically. For `401`, check key configuration without
  revealing it; for `422`, correct the indicated request fields. For `429`
  or `529`, honor `Retry-After` if present and use bounded exponential
  backoff (at most three retries). Do not loop on other errors.
- Never enable request/header debug logging or print the API key.

Authoritative references: [API](https://docs.typesafe.ai/api),
[models](https://docs.typesafe.ai/models),
[confidence](https://docs.typesafe.ai/confidence), and
[documentation index](https://docs.typesafe.ai/llms.txt).
