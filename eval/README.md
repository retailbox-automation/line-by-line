# Voice-to-line benchmark

How well does a mechanic's spoken note become the right lines of the shop's price list? This folder measures it.

## The set

- `findings.json`: 32 notes, each with the price-list codes a service writer would add and an urgency (`safety`, `soon`, `can_wait`). `[]` means no billable line (nothing found, or the work is not in the price list).
- `audio/F01.wav` to `F32.wav`: the same notes spoken by macOS text-to-speech (`say`, 16 kHz mono). 12 voices, 175 to 215 words per minute, and every second note has shop-like noise (pink noise plus a 60 Hz hum). `audio/manifest.json` lists voice, speed and noise per file.
- `../data/price-list.json`: the fictional price list of "Bayside Auto Care" (32 items). The model never sets a price; code looks it up by code.

**Synthetic test input, labeled by us.** The notes were written by us in a mechanic's voice and spoken by text-to-speech. They are not real customers and not real mechanics, and real shop audio will be harder. The numbers below say how the pipeline does on this set, not how it will do in a shop.

## The numbers

| Number | Meaning |
|---|---|
| **Exact notes N/32** (the main one) | notes where the set of codes equals the expected set |
| precision, recall | over all codes of all notes |
| invented codes | codes the model named that are not in the price list (dropped before they reach a line); goal 0. As in the Python prototype, scoring uses the model's answer before that filter: an invented code counts as a false positive and the note is not exact. A code named twice keeps its last urgency |
| urgency | urgency right, counted on lines whose code was right |
| WER | word error rate of speech recognition against the note text. Spoken and written numbers count as equal (`two millimeters` = `2mm`, `a hundred and ten thousand` = `110,000`, `P zero four two zero` = `P0420`). No other normalization, so contractions and homophones still count as errors |
| latency p50, p95 | speech recognition plus lines, per note, upper median as in the Python prototype |

## Lower bound: no model

The `keywords` provider matches price-list aliases and item names in the text and reads urgency from cue words. It is a port of the prototype in `docs/2026-10-31-lbl-measure/score.py` of the campaign repo, and its numbers are the parity reference:

| Input | Exact notes | Precision | Recall | Invented | Urgency |
|---|---|---|---|---|---|
| the note text | 16/32 | 0.818 | 0.545 | 0 | 18/18 |
| after local speech recognition (`recorded:parakeet-local`) | 12/32 | 0.765 | 0.394 | 0 | 12/13 |

## With a model (Groq, 2026-11-03)

Groq's free tier with zero data retention on, temperature 0, the strict JSON schema of `src/agent/lines.ts`. The answers are recorded in `recordings/llm/`, so `--llm recorded:<name>` replays them without a key.

| Lines | Input | Exact notes | Precision | Recall | Invented | Urgency | p50 / p95 per note |
|---|---|---|---|---|---|---|---|
| `groq:openai/gpt-oss-120b` | after local speech recognition | 32/32 | 1.000 | 1.000 | 0 | 25/33 | 6.9 s / 11.3 s |
| `groq:openai/gpt-oss-120b` | the note text | 32/32 | 1.000 | 1.000 | 0 | 23/33 | 4.0 s / 9.3 s |
| `groq:openai/gpt-oss-20b` | after local speech recognition | 32/32 | 1.000 | 1.000 | 0 | 19/33 | 8.5 s / 11.6 s |

Both models get every code right on these 32 notes, so the set no longer separates them on codes; urgency does (gpt-oss-120b 25/33). The demo uses gpt-oss-120b. The times include waiting out the free tier's 8K tokens a minute. A larger and harder set is the next step.

```bash
npm run eval -- --stt recorded:parakeet-local --llm recorded:gpt-oss-120b-parakeet   # replays the 32/32 run, no key
```

Any model has to beat these. `eval/run.test.ts` fails if the port drifts from them.

## Run it

```bash
npm run eval -- --replay                       # recorded speech recognition + keywords (default), no key
npm run eval -- --text                         # the written note instead of speech: measures only the line step
npm run eval -- --stt recorded:parakeet-local --llm recorded:<name>
npm run eval -- --stt groq:whisper-large-v3-turbo --llm groq:openai/gpt-oss-120b --record <name>
```

- Speech providers: `recorded:<name>` (`recordings/stt/<name>.jsonl`), `groq:whisper-large-v3`, `groq:whisper-large-v3-turbo`, `local:parakeet` (the `stt-local` tool on the development Mac, not for hosting).
- Line providers: `keywords`, `recorded:<name>` (`recordings/llm/<name>.jsonl`), `groq:openai/gpt-oss-120b`, `groq:openai/gpt-oss-20b`.
- `groq:*` is a paid service and is refused before any network call unless `LBL_LLM_LIVE=1` and `GROQ_API_KEY` are set. Tests that exercise the live path set `LBL_LLM_LIVE=1` and a fake key with `fetch` stubbed out; no test reaches the network.
- `--record <name>` saves the answers of the live providers of that run to `recordings/` (it refuses to overwrite), so the run can be replayed later without a key.
- With `--record`, each answer is appended to the recording file as it arrives, so a run that fails on note 31 keeps the answers of notes 1 to 30 (they are not reused automatically: the name is then taken, so pick a new one or move the partial file).
- Every run writes `results/<speech>__<lines>.json` (per-note rows, transcripts, WER) and prints a one-line summary for the README.
- `recordings/stt/parakeet-local.jsonl`: transcripts from NVIDIA Parakeet-TDT-0.6B-v3 run locally on all 32 audio files (0 errors, p50 755 ms).
