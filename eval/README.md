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

Both models get every code right on these 32 notes, so the set no longer separates them on codes; urgency does (gpt-oss-120b 25/33). The demo uses gpt-oss-120b. The times include waiting out the free tier's 8K tokens a minute. The hard set below separates them.

```bash
npm run eval -- --stt recorded:parakeet-local --llm recorded:gpt-oss-120b-parakeet   # replays the 32/32 run, no key
```

Any model has to beat these. `eval/run.test.ts` fails if the port drifts from them.

## Hard set (2026-11-06)

`hard/` holds 48 harder notes (H01 to H48, 68 codes, 4 notes with no billable line) with its own audio, recordings and results. Run it with `--set hard`.

- **What makes it hard:** several jobs in one note (up to four codes), work already done or declined by the customer, price-list words that are not a job ("customer asked how much a new battery would be, hers is fine"), shop slang ("dog bone mount", "half shaft", "CCA"), self-corrections ("front pads, no wait, the rear pads"), work the shop does not do next to work it does, and urgency stated against the usual default.
- **Labels checked blind:** two independent labelers (Claude Opus 5.5, effort high), given only the note text, the price list and the shop's rules, agreed with our labels on all 68 codes and all 68 urgencies (`hard/label-check.json`). Where a labeler said a careful service writer could answer differently, the note carries the tag `urgency_judgment` (11 notes) or `code_judgment` (2 notes).
- **Louder audio:** every note is noisy, mixed at an exact signal-to-noise ratio of 12, 8 or 5 dB (RMS of the voiced samples over the noise) with three noise profiles: shop (pink noise and a 60 Hz hum), compressor (brown noise), phone (voice and noise band-limited to 300 to 3,400 Hz, with an air-tool whine). 16 macOS voices, 200 to 240 words a minute (`hard/make_audio.py`, `hard/audio/manifest.json`).
- **Speech recognition:** local parakeet, as in the demo: WER mean 0.218, median 0.125. Five transcripts (H07, H09, H24, H25, H36, all at 5 or 8 dB) are noise (WER above 0.6), so the speech path can reach at most 43/48.

| Lines | Input | Exact notes | Precision | Recall | Invented | Model errors | Urgency | p50 / p95 per note |
|---|---|---|---|---|---|---|---|---|
| `keywords` | the note text | 10/48 | 0.563 | 0.529 | 0 | 0 | 24/36 | - |
| `keywords` | after local speech recognition | 8/48 | 0.533 | 0.353 | 0 | 0 | 13/24 | - |
| `groq:openai/gpt-oss-120b` | after local speech recognition | **37/48** | 0.964 | 0.794 | 0 | 0 | 46/54 | 5.2 s / 11.4 s |
| `groq:openai/gpt-oss-20b` | after local speech recognition | 32/48 | 0.923 | 0.706 | 0 | 5 | 48/48 | 8.8 s / 15.1 s |
| `groq:openai/gpt-oss-20b` | the note text | 47/48 | 1.000 | 0.985 | 0 | 0 | 66/67 | 9.8 s / 13.1 s |

What the numbers say:

- The hard set separates the two models where the base set could not: after speech recognition `gpt-oss-120b` gets 37/48 and `gpt-oss-20b` 32/48. Every note the smaller model got right, the larger one got right too.
- A **model error** is an answer Groq rejected because it broke the strict JSON schema (`400 json_validate_failed`). The note counts as missed; in the product the mechanic would see an error and dictate again. `gpt-oss-20b` did this on 5 of 48 transcripts (H09, H18, H20, H27, H46), `gpt-oss-120b` on none.
- On the five transcripts that are noise, `gpt-oss-120b` drafted no line at all rather than inventing one. Of its other misses, most come from speech recognition ("great fluid" for "brake fluid", "reels" for "rears"); two are the model's own (H08 left out the rear pads, H18 read "new light" as a headlight).
- On the clean note text `gpt-oss-20b` already gets 47/48, so the line step itself is nearly solved on this set; what separates models is the noisy transcript. `gpt-oss-120b` on the note text was not run: on 2026-11-06 the free tier's 200K tokens a day for that model were kept for the hosted demo (one note costs about 1.45K tokens).

```bash
npm run eval -- --set hard --llm recorded:gpt-oss-120b-parakeet   # replays 37/48, no key
npm run eval -- --set hard --llm recorded:gpt-oss-20b-parakeet    # replays 32/48 with 5 model errors
npm run eval -- --set hard --text --llm recorded:gpt-oss-20b-text  # replays 47/48
```

`eval/run.test.ts` replays these recordings and fails if the numbers drift.

## Run it

```bash
npm run eval -- --replay                       # recorded speech recognition + keywords (default), no key
npm run eval -- --set hard --replay            # the same on the hard set (eval/hard)
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
