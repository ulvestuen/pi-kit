---
name: decisions
description: Evaluates text and images with TypeSafe's JEV API or OpenAI's Decisions API. Use for classification, routing, yes/no probabilities, rubric-based scoring, or JEV bounding-box localization, not text generation.
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
| `jev` | `TYPESAFE_API_KEY` | `https://api.typesafe.ai/v1/systemone` | `jev-latest`; `jev-1.14.0` for `box` questions |
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
user's data-sharing restrictions regardless of key availability. Both providers
accept images, but native bounding-box answers here require JEV. If selection
yields OpenAI for a bounding-box task, ask before switching. Do not silently drop
images or substitute a text description. Never switch providers after an API
failure. The request command remains explicit so the provider cannot change
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
| Images | `assets` map of base64 images; reference keys in `state`, `instructions`, or `criteria` | `input_image` parts with inline data URLs |
| Questions / answers | Maps keyed by question ID | Arrays; give questions unique `name` values, echoed in answers |
| Yes/no | `type: "noul"`; optional `criteria.true` / `criteria.false`; answer `noul` | `type: "predicate"`; criteria go in `instructions`; answer `probability` |
| Choice | `criteria` map of option names to descriptions (or `null`) | `choices` array of `{value, description?}`; values are strings or booleans |
| Score | `criteria` array of ordered descriptions | `levels` array of `{label, description?}` |
| Bounding box | `type: "box"`, `instructions`, no `criteria`; answer `box` + `confidence` | No native box type in this skill |
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

#### Images and bounding boxes

JEV images and Box are experimental, not production-ready. Keep visual questions
simple and validate accuracy on your own images. The helper automatically sends
`TypeSafe-Danger-Zone-Images: true` for JEV requests with nonempty `assets` or a
`box` question; text-only and OpenAI requests do not get this header.

Image input works with Jev 1.13 and 1.14. Box needs Jev 1.14, so requests containing
`box` default to the pinned `jev-1.14.0` instead of relying on the stable alias.
An explicit `model` always wins: use `jev-1.14.0` or `jev-preview` for boxes,
not `jev-1.13.0`. The helper leaves model compatibility validation to the API;
it never silently upgrades an explicit model or drops an unsupported question.

After selecting JEV, run this to classify and locate a mug in a prepared PNG:

```sh
node --input-type=module - ./photo-ready.png <<'JS' | node {baseDir}/decisions.mjs jev -
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const ref = randomUUID();
const data_base64 = (await readFile(process.argv[2])).toString("base64");
console.log(JSON.stringify({
  model: "jev-1.14.0",
  state: { photo: ref },
  assets: { [ref]: { type: "image", format: "png", data_base64 } },
  questions: {
    mug_visible: { type: "noul", instructions: "Is there a coffee mug in `photo`?" },
    material: {
      type: "choice",
      instructions: "What is the mug nearest the sink in `photo` made of?",
      criteria: { ceramic: "Ceramic", glass: "Glass", other: "Other material or no mug" }
    },
    mug: { type: "box", instructions: "the coffee mug nearest the sink in `photo`" }
  }
}));
JS
```

The helper stays JSON-only: use `data_base64` plus `format: "png"`, `"jpg"`, or
`"jpeg"` matching the file. Base64 must use the standard alphabet, `=` padding,
no whitespace, and **no `data:` prefix**. It adds about a third to the file size.
JEV also supports more efficient multipart uploads, but this helper does not:
do not use `assets.*.part`, local paths, or hosted URLs as image payloads.

Each asset key is a reference replaced by the API anywhere in string **values**
inside `state`, `instructions`, or `criteria`, including nested objects/arrays and
mid-sentence. Use a fresh UUID, not a common word that could match other text.
Every asset must be referenced; object keys are not replaced. To classify using
example pictures, put their references in Choice descriptions, Score levels, or
Noul `true`/`false` criteria. Repeated references add repeated image input tokens
and expanded bytes; put shared images in `state` once and refer to their field
paths in questions, as above.

Prepare images before sending; the helper does not resize, rotate, or convert:

- Still PNG or JPEG only; animated PNG is rejected. Rotate the actual pixels
  upright first: JEV strips metadata and does not apply EXIF orientation.
- Both width and height must be 280–1568 pixels, inclusive. Resize, pad, or crop
  first; preserve the transform when mapping boxes back to the original image.
- At most 16 MiB per decoded image and 32 MiB for the JSON request including
  base64. Separate 32 MiB limits apply to processed images combined and to the
  expanded request; repeating references can exceed these even with small uploads.
- `400` can mean an invalid image/reference/format or excessive context; `413`
  means a size limit. Fix the input rather than retrying it unchanged.

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

JEV Box returns `{"type":"box","box":{"top":0.25,"bottom":0.82,"left":0.44,"right":0.84},"confidence":0.92}`.
Edges are fractions from 0 to 1 measured from the top-left of the submitted image:
multiply left/right by its width and top/bottom by its height for pixel edges.
There is one box per question, **no "not found" result**, and confidence is not
an existence probability. Pair each target with a Noul presence check, as above,
and ignore the box when presence is too unlikely for your application. The helper
returns both unchanged; choose thresholds using labeled images, not a universal
cutoff. Name which target you want if several match. For small targets, crop to a
region first; boxes on a crop are relative to that crop, not the full image.

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
[images](https://docs.typesafe.ai/images), [Box](https://docs.typesafe.ai/primitives/box),
[models](https://docs.typesafe.ai/models), and [confidence](https://docs.typesafe.ai/confidence);
OpenAI [guide](https://developers.openai.com/api/docs/guides/decisions) and
[API reference](https://developers.openai.com/api/reference/resources/decisions/methods/create).
