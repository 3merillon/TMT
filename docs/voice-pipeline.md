# Campaign voice-over

The current authored campaign has 111 English clips across eight distinct voices. All mission briefings, intel, radio lines, optional-cache acknowledgements and both endings are generated. The v3 bake uses complete utterances and a campaign pronunciation dictionary, totaling 1.82 MiB and 11 minutes 52 seconds. No speech model or inference runtime loads in the browser.

## Rebuilding

The local sibling `planets` repository supplies its existing Pinionfall Kokoro pipeline, phonemiser, voice library and cached fp32 model. It is read without modifying that repository.

```sh
npm run bake:voice -- --pipeline ../planets --workers 2
npx vitest run tests/audio-campaign-voice.test.ts tests/audio-campaign-prosody.test.ts
npx tsx scripts/review-campaign-voice.ts
```

Prerequisites: the Planets `tools/voice-runtime` installation/model cache, Node and ffmpeg. `scripts/campaign-voice-corpus.ts` extracts dialogue literals and shared beat arguments from the actual mission source; it includes conditional branches, briefing/intel text and dynamic cache acknowledgements. New types of dynamically assembled speech must be added explicitly to this collector. The coverage test rejects missing or stale manifests.

`scripts/campaign-voice-worker.mjs` adapts the same pinned fp32 model, pronunciation tables and voicepacks. It caches lossless PCM and the actual input phonemes under ignored `artifacts/voice-cache`, checks non-finite/silent waveforms and refuses phrases exceeding the model context instead of truncating them. The final character pitch/EQ/color and constant-gain mastering pass exports 24 kbit/s, mono, 24 kHz Ogg Opus. Rate and pitch are composed using synthesis speed = rate / pitch. Model revision and notices ship with the manifest. The retained Apache, HeadTTS and Misaki licenses are in `public/audio/campaign`.

## Pacing and performance

The v3 bake generates complete utterances and only extends silence between them. Sprocket uses a complete sentence per inference: conversational commas stay in context and do not cause an artificial pause or a fresh intonation contour. His greetings are "Morning rookie" and "Not bad rookie." Other cast members retain their approved phrase direction at commas, semicolons, colons, spaced dashes and ellipses. Decimals, abbreviations and hyphenated words stay intact. No silence is inserted inside a generated utterance. Assembly preserves every source sample exactly once and refuses sources whose first or last 10 ms contain speech. Source hashes and sample counts are checked against the assembled waveform before mastering. Outer silence trimming preserves quiet consonants with 80/120 ms padding. Estimated phoneme offsets alone are insufficient for placing pauses: they can fall inside continuous speech, and time stretching invalidates them.

Objective labels without terminal punctuation receive a full stop in the synthesis input so the model has a statement ending. The displayed text stays unchanged. Questions and exclamations retain their authored punctuation. The manifest records `synthesisText` when it differs from the subtitle, and coverage checks require the current cast and terminal punctuation treatment.

`scripts/campaign-voice-direction.ts` is the offline performance score. Base added breaks are 170 ms for commas, 290 ms for heavier clause boundaries and 580 ms for hesitation; character and delivery modifiers adjust these. Sentence pads are approximately 300–600 ms. Final pads also leave room between the narrator and briefing intel. These gaps are inserted after rate/pitch correction, so a lower character voice cannot squeeze the pauses away. The radio's existing 350 ms caption hold adds space between queued lines; pause/resume and Skip operate on the whole finished waveform, including breaths.

Each character has a calmer base speaking rate. Phrases with five or more words have a delivery ceiling of 170–185 words/minute, measured over their generated duration. Rushed takes are regenerated with a slower native synthesis speed; no `atempo` or other time stretching is applied. Short calls retain their attack. Mastering applies one constant gain per line, with peak headroom, avoiding compression pumping around gaps. Important story exchanges have explicit per-sentence choices for warmth, urgency, reflection, gravity and resolve. Kokoro does **not** accept acting prompts: those choices control restrained rate, pitch, level and pause changes. They supplement the model's own intonation; they do not guarantee a dramatic performance.

## Pronunciation

`scripts/campaign-pronunciation.json` supplies reviewed Kokoro phonemes for campaign names and unusual words: **TIDE-well**, **EE-ther**, Seraphine, Kestrel, Rustcrown, Millbrook, Mainspring, whiteout and others. Separate context rules select the appropriate meanings or stress of wind, lead, close, use, contest, separate, concrete, bases, rewind and remake. These are explicit rules for the current script, not automatic part-of-speech inference. A new use outside an accepted context fails the bake for review.

Every word must have a known dictionary entry or supported inflected base. Unknown words cannot silently fall back to guessed lore pronunciations. The tokenizer must retain every phoneme; compound hyphens are explicitly translated to spaces because this model has no hyphen token. The local dictionary hash participates in cache invalidation and is recorded in the manifest. `scripts/campaign-voice-audit.ts` checks the per-word phonemes actually supplied to the model, including possessives, against the reviewed pronunciations. Editing this dictionary requires a new bake.

Audition eight cast members without changing shipping assets:

```sh
npm run bake:voice -- --limit 8
npx tsx scripts/review-campaign-voice.ts --dir artifacts/voice-preview --out artifacts/voice-preview-review
```

Compare a different voice on the same directed lines without changing the shipping cast or overwriting another audition:

```sh
npm run bake:voice -- --audition am_onyx --speaker "Sgt. Sprocket" --ids 9c703eb9,0b1185bd,7ffb7ca9
```

Auditions require explicit clip IDs belonging to that speaker and write to `artifacts/voice-auditions/<voice>`. They use the same synthesis, punctuation, mastering and validation path as production.

Use `--ids 01d7d2e5,9c703eb9,7247a56f` for Brann's rivet line, Sprocket's greeting and the Tidewell pronunciation. The greeting is authored as "Morning rookie." so it stays a single conversational phrase. The preview always writes under `artifacts/voice-preview`. The review command writes a searchable HTML listening page, a signal report and a vocabulary/phoneme concordance. It requires the retained PCM sources from the bake (`--cache` can select another cache directory). Optional `--baseline <folder>` compares against a saved manifest and its Ogg files. The full review page is `artifacts/voice-review/index.html` (local and ignored).

| Character | Voice | Direction |
|---|---|---|
| Narrator | bm_lewis | Warm, measured storybook delivery |
| Sgt. Sprocket | am_onyx | Seasoned field sergeant; complete sentences, restrained radio coloration |
| Marshal Corvin | bm_george | Low, controlled authority |
| Mags | af_heart | Bright, practical pilot |
| Rook | am_michael | Direct, quietly determined young commander |
| Brann | am_fenrir | Lower Forge resonance, restrained chest EQ |
| Seraphine | bf_isabella | Calm Aether voice, faint crystalline double |
| Harbor Master | bm_daniel | Brisk harbor officer |

`manifest.json` records the model revision, exact casting, clip text, decoded duration, size, phrase/sentence timeline, source hashes, native speed and word-level phonemes. Runtime imports only the small clip catalog. Filenames include a digest of the finished Ogg, so changing a performance invalidates browser caches even when the subtitle text is unchanged. The bake publishes catalogs only after every clip succeeds, then prunes its own obsolete hashed Ogg files. Human files and licence notices are preserved.

## Playback

The campaign board offers **Listen to briefing** (followed by available intel). Starting a mission queues its narrator briefing before its opening dialogue. The radio keeps every queued line, synchronizes its caption to actual audio completion, and provides **Skip radio**. The final lines remain visible above the result screen. Failure, retry and leaving the mission cancel stale speech.

Menu redraws preserve a playing briefing: the controller only announces audio scene changes when the route or world changes. An empty mission HUD cannot cancel the board's speech during background initialization. Leaving the board cancels its briefing, including browser navigation back into a paused match.

Audio uses the existing unlocked Web Audio context and Dialogue volume bus, with music ducking while a speaker is active. Pause preserves the sample offset; tab hiding suspends the context. Failed requests use timed subtitles. Only requested clips decode, with at most twelve PCM buffers retained; fetch cancellation and generation checks prevent old mission lines playing after restart. `window.__tmtGame.audio.dialogue` reports playback, pause, clip filename, decoded duration, elapsed position, cache, completions and errors.

Validation includes corpus/file coverage, content hashes, unique casting, Ogg signatures, text-preserving segmentation, punctuation edge cases, exact preservation of speech samples, rejection of voiced joins, pronunciation regressions, cancellation during decode, failed fetch fallback and offset-preserving pause/resume. The offline review checks every retained phrase source and pronunciation record, then decodes every shipped clip and checks speech energy, peak level, exact duration and the silent interior of every scored pause after mastering and Opus compression. Silence-only checks cannot detect damage to adjacent speech; source boundaries and sample retention are checked too. `scripts/capture-plans/campaign-voice-pacing.json` exercises a real browser briefing → radio → pause → resume → skip → leave flow. Automated checks cannot detect every naturalness or synthesis defect; listening review remains necessary.

The recorded v3 review passed 111 clips, 262 intact utterances and their pauses, and 50 occurrences of explicitly controlled pronunciations. Its vocabulary audit covered 559 distinct written forms; the voice/prosody and prologue suites passed 22 tests. These are recorded bake results, not fresh verification of later corpus changes. The generic audio preview looks up one line by subtitle text and only warns when it cannot play it; a successful preview alone does not establish corpus coverage. Runtime speech currently requests Ogg Opus without an alternate codec, with timed subtitles as the fetch/decode fallback.
