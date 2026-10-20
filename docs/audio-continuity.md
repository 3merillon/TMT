# Audio: the score, the effects and the single transport

The application owns one persistent score transport and one effects engine from the title screen through menus, workshop,
loading, battle, pause, results, retry and browser Back/Forward. The score is an original pre-rendered electro-metal
soundtrack played as sample-synchronized layer stems; the effects are two pre-rendered banks with the procedural recipes
kept as a fallback until a bank has decoded. Nothing was recorded, sampled or downloaded: every asset is synthesized by
`scripts/audio-forge` (physically modelled strings through an amp and cabinet stage, synthesized drums and industrial
electronics, FDN reverbs, a mastering stage) from authored compositions. Campaign speech uses a separate offline
[voice pipeline](voice-pipeline.md). Runtime music and effects assets are indexed by
`src/audio/score-manifest.json` and `src/audio/sfx-manifest.json`.

## Score

**Identity.** One motif carries the game: `B B D C B · A B | F#——— E F# G F#` (two bars, lead register), stated by the
lead guitar over the main-theme riff, broken down at half time, driven double-time and returned as the hook. Every world
and boss track restates it in its own key, metre and timbre (`motif()` in `scripts/audio-forge/scores/shared.ts`), the
fleet launch turns it major at its last stage, the Rustcrown corrupts it with a flat second and a tritone, and both
endings resolve it.

| Track | Key · tempo | Character | Layers |
|---|---|---|---|
| `title` Tiny Metal Tank | B minor · 108 | Main theme: machine intro, low-tuned chug riff, motif, half-time breakdown, double-time drive, hook | core / guitars / lead |
| `workshop` Copper Lathe | B minor · 96, swung | Half-time groove: crunch funk-chug, snarling bass, lathe pulses, muted motif | core / guitars / lead |
| `cradle-explore` Lamp Hill · `cradle-combat` Relay Drive | E minor · 118 / 158 | Temperate machinery: patient muted pulses, bells; propulsive gallop, open chords, snarl-bass answer | core / combat / lead / escalation |
| `dune-explore` Rim Wind · `dune-combat` Sandstorm Teeth | F phrygian · 104 in 7/8 / 146 | Abrasive: semitone grinds, anvils and chains, tremolo lines, stops | same |
| `frost-explore` Observatory Glass · `frost-combat` Calving Line | C# minor · 92 / 170 | Cold precision: single-note picking, FM bells, glass pads, fractured glitch | same |
| `forge-explore` Slag Tide · `forge-combat` Furnace Hammer | A minor, drop-A · 84 / 136 | Furnace-heavy: slams, half-time crush, double-kick bursts, steam and pipes, sub drone | same |
| `halo-explore` Driftstone Static · `halo-combat` Orbital Mechanics | D minor with tritone planing · 128 / 174 | Unstable electronics: arps, 3+3+2 accents, glitch sequences, planing chords | same |
| `boss-crawler` The Siege Crawler | F minor · 132 | Lumbering march; phase 1 adds the phrygian motif, phase 2 double-kick and a siren | core / riff / phase 1 / phase 2 |
| `boss-leviathan` · `boss-titan` · `boss-rustcrown` | E minor 120 · C# minor 150 · B minor 160 | Surging swells and bells; precise double-kick and calving hits; the corrupted motif as a mirror duel, the core phase adds a blast layer and a choir-like pad | same |
| `fleet-launch` Council of Embers | E minor · 148 | Hold-out hymn that grows per launched fleet; brass-like stacks at the last stage | stage layers |
| `finale-escape` Unwinding · `finale-choice` The Mainspring | B minor · 184 / 70 | Relentless thrash with blast beats; sparse bells and a heartbeat for the choice | — |
| `ending-rewind` · `ending-release` | D major · 96 / B minor→D · 72 | The motif in major with big guitars; clean-guitar motif, pads and wind as the worlds slow | — |
| `stinger-*` | — | victory, defeat, mission-start, checkpoint (a/b/c), boss-phase, boss-defeated, escalation, undermined, near-miss, kill-streak, objective, ending-rewind, ending-release | one-shots |

Each loop track is an intro (1–4 bars) plus a 16–32-bar loop whose reverb and decay tails are folded into the loop
start, so the seam is the natural ring-out onto the downbeat. Layers are rendered as one Opus file per layer from stems
that received the **identical** glue-compressor and limiter gain curves (computed on the full mix), so the layers still
sum to the mastered mix and any subset is a valid mix. Combat tracks target −12.5 LUFS, exploration −16 to −17, the title
−13, all at −1 dBTP.

**Adaptive playback** (`src/audio/score/director.ts`, pure; `player.ts`, WebAudio). The director maps scene, world set
(by mission id, because Frostmere and the Halo share a planet kind), the measured threat, the boss phase, the finale
phase, the fleet-launch stage and the ending to a track and five layer weights (the fifth, a bass layer, follows the
core; no shipped track has one). The threat ladder has four steps with enter/exit hysteresis, a 4 s hold and a 9 s
cooldown before exploration returns, so layers never flicker; tier 1 would play a `<set>-hunt` track and even matches a
`<set>-combat-b` track, and phase 2 of a boss a `<boss>-p2` loop, but none of those ship, so the director falls back to
the world's combat track and the boss track's layers. Track changes are quantized to
the outgoing track's next bar (next beat for menu, pause and results changes, which must feel responsive) as a cut, not
a blend: the outgoing track fades over its last 0.3–0.5 s and ends exactly on the boundary where the new track starts,
so two tempos never overlap; a request for the playing track only ramps its layers; repeated scene events never restart
anything. Every menu screen, the setup and the workshop share the workshop groove, so moving between menus only moves
layer weights; a track plays its intro only when music starts from silence, and every return resumes the track at the
bar it was last heard. Pause lowers the level and keeps the transport; results keep the track under the victory/defeat
stinger. Stems decode through a 32 kHz OfflineAudioContext (half the resident memory of the 48 kHz context rate; the
sources resample) into an LRU cache with a 128 MiB target and prefetch pins for the current world's pair. Dialogue ducks music −8 dB
and world effects −4 dB; big near booms duck music −6 dB; incoming-fire alerts dip the world effects briefly on their
own bus.

## Effects

Two mono sprite banks (`src/audio/sfx-manifest.json`): `public/audio/sfx/bank.ogg` (core: machine guns, snaps,
ricochets, reloads, armour, loops, UI) and `bank-heavy.ogg` (weapons, explosions, destruction), both decoded at start,
each independently; a sound is one AudioBufferSourceNode reading a sub-range of its bank behind a budgeted spatial voice.
Designs follow the physical cause (`scripts/audio-forge/sfx/designs.ts`, `designs-v2.ts`):

- weapons: the cannon is a howitzer-class report in five layers (sub thump 35–60 Hz, mid punch 150–400 Hz, the crack with
  the breech click, the rolling tail with two darkened slapbacks off the planet, the mechanical follow-through: casing
  ejection, breech cycling, pressure hiss) with near, **mid (8–20 u)** and far takes crossfaded by distance (six near
  takes; per-shot pitch and layer-gain randomisation at runtime); the mortar's hollow thoomp with the shell's exit
  whistle; the rail's capacitor throb that is felt, electric scream, sonic crack and long ionised tail; the arc cannon's
  discharge with arcs that go on crackling at the target; the autocannon; the forge mortar;
- machine guns: a seamless sustained-fire loop per firing gun (varied round timing, a mechanical rattle bed, bolt thuds)
  that follows the gun and stops with a tail (bolt clatter, hot-barrel ticks, link rattle); supersonic snaps for rounds
  passing within 2 u of the focus; impact pings by material (armour ping, rock chips, a dusty concrete thwack, a soil
  thud, a water plunk);
- explosions by munition, crater size and material (soil clods, rock chips, concrete slabs and dust, metal shards and
  shrapnel whistles) with a shock-wave huff and a delayed planet echo, far variants, the nuclear round's suck-back
  pre-roll, a brief 3 kHz ear ring on the biggest near blasts; rubble settling at committed cuts;
- destruction: the main burst, the turret ring-out at +0.5 s, secondary pops (ammunition cooking off) over the next
  2–6 s, the burning-wreck loop; a near-miss cue (a hostile shell within 3 u) and a kill-streak cue (three kills in ten
  seconds) fire their stingers through the score;
- armour: ricochet, penetration, tearing on heavy direct hits, reactive-armour spends, shield shimmer, EMP;
- actor loops: Dragonfly rotor, Skimmer hover, Rustling swarm, the Crawler's furnace, Spire hum, searchlight servo, shield
  hum; suspension thumps and landings;
- the engine worklet: a multi-cylinder diesel with gear shifts (the pitch saws up through four gears with a load dip and
  a clunk at each shift), a turbo that spools with inertia and blows off when the load drops, metallic track clatter on
  hard turns, and a low-health misfire mode (uneven firing, dropped firings, backfires); tread grains through pad/pin
  resonators; slip squeal; a servo on turret motion.

Mix hierarchy (`src/audio/buses.ts`): world effects → dialogue duck → alert duck → master; music → boom duck →
dialogue duck → group; alerts and UI on their own group; a −6 dB limiter catches the biggest booms. The voice budget is
56 with per-bus burst caps.

## Verification (17 October 2026, with the restored score)

- `npx tsc --noEmit`, `npx tsx scripts/guards.ts`, `npx vitest run --project audio --project ui` (351 tests): the
  director's tiers and fallbacks, five-layer plans, the sustained machine-gun loop with its tail and snaps, both banks and
  every sprite the runtime names, the 75 MB decode cap per track, engine gears/turn/damage, plus the pre-existing suites.
- `node --import tsx scripts/audio-preview.ts` and `--boss` (real Chromium through the real hooks) with the restored
  music: combat reaches tier 4 on `cradle-combat` with its four layers, the cooldown holds the combat track's body layer
  at tier 1, the Crawler's phases drive the boss track's layers; see `artifacts/audio-preview/verification.json` and the
  `runtime-*.wav` recordings. A P1 autopilot capture (`scripts/capture.ts`, telemetry from `window.__tmtGame.audio`)
  shows the new stingers firing in the real game.
- Measured costs: the table below.

## Game and campaign integration

Audio is presentation only. Campaign scripts emit `{ type: 'audio', cue }` through their script API; the pure
[`AudioCue` types](../src/game/audio-cues.ts) live in the simulation layer without importing an audio engine.
Presentation code can call [`dispatchAudioCue`](../src/audio/cues.ts), which sends `tmt:audio-cue` and is a no-op
without a browser window. Gameplay never reads an audio result.

| Integration | Contract |
|---|---|
| `registerHooks('audio', { onMatchStart, onEvent, onFrame, onMatchEnd })` | Owns match reports, impacts, results, listener updates, actor loops and measured threat |
| `tmt:audio-scene` `{ scene, world }` | Selects the score scene without creating another transport or restarting an unchanged track |
| `tmt:settings` `{ audio: { master, music, sfx, ui, voice } }` | Updates independent volume buses |
| `playCampaignVoice(speaker, text)` / `stopCampaignVoice()` | Plays dialogue on the shared context and ducks music/world effects |
| Session `realtime` events and snapshots | Supply tracer activity, objectives, mission state, actor motion, health, components and shields for presentation |
| `boss` / `boss-end`, `finale`, `escalation`, `ending` | Select explicit musical state; repeated boss/phase cues are ignored, and explicit boss state takes precedence over derived component/mission state until cleared |
| `threat` `{ value, seconds? }` | Overrides measured threat for a bounded hold (default six seconds), then returns to the measured estimate |
| `checkpoint`, `stinger`, `ui` | Trigger checkpoint variants, named musical accents and feedback sounds; these are transient cues |

The Crawler emits phase changes and `boss-end`; other boss beats emit enter/exit cues. Finale beats select duel, core,
escape and choice treatments. Fleet launches emit escalation counts, the mission runner emits the ending choice, and
successful checkpoint saves emit `checkpoint`. Capture/depot, repair, reload-ready, overheat and searchlight signals
use the same cue API. Derived component/beat state remains a fallback when explicit state is absent.

Near-miss and kill-streak stingers are derived from hostile impacts and kills. Objective completion prefers its musical
stinger when music is playing, with the UI chime as fallback. A tracer starts or refreshes a gun's sustained loop;
0.18 seconds without another tracer ends it with a mechanical tail. These signals do not create new gameplay rules.

## Rebuilding and limitations

The forge needs the checked-in Node dependencies and ffmpeg with libopus. Set `TMT_AUDIO_OUT` to an ignored artifact
directory or an external working directory for lossless masters, previews and analysis. For example, in PowerShell:

```powershell
$env:TMT_AUDIO_OUT = Join-Path (Get-Location) 'artifacts/audio-forge'
node --import tsx scripts/audio-forge/render-music.ts title
node --import tsx scripts/audio-forge/render-sfx.ts
node --import tsx scripts/audio-forge/preview-escalation.ts title
node --import tsx scripts/audio-forge/engine-audition.ts
```

Music and effects renders update shipping Ogg files and their manifests. Run music renders one at a time because they
write the same score manifest. Preview layering needs the corresponding lossless layer masters. Runtime browser
verification uses `node --import tsx scripts/audio-preview.ts` (`--stress` or `--boss` selects additional scenarios).

The loaders currently request Ogg Opus assets without codec negotiation. The encoder can produce AAC, but no AAC
fallback is selected at runtime, so Ogg decoding must be qualified on each supported browser. The browser audio preview
looks up its sample voice line by text and only warns if that clip is absent; use the voice corpus/coverage checks in
[the voice guide](voice-pipeline.md) to validate dialogue coverage.

Dedicated audio signals and sounds are absent for unimplemented campaign set pieces such as Leviathan surfacing,
Titan pylon calving, dam flooding, the ore-train chase and collapsing escape terrain. Several planned enemy abilities
also lack dedicated one-shots. Existing actor/shield loops or generic incoming alerts do not establish those mechanics.
Hunt, alternate combat and separate phase-two boss tracks are not shipped; the director uses the documented fallbacks.

## Shipped assets and costs

Lossless masters, per-stem and per-layer WAVs, previews and analysis stay in the configured working directory.
The runtime downloads Opus music layers lazily per scene; both effects banks load after audio starts.
The current checked-in manifests describe:

| Asset | Encoded files | Encoded bytes |
|---|---:|---:|
| Music (36 tracks and stingers) | 88 | 36,608,712 |
| Core effects bank (51 sprites) | 1 | 702,726 |
| Heavy effects bank (32 sprites) | 1 | 1,014,686 |

Music layers are 64 kbit/s stereo Opus and effects banks are 64 kbit/s mono. At the intended 32 kHz music decode
rate, the largest complete track occupies approximately 74.6 MB (71.1 MiB) of PCM. At a 48 kHz effects decode rate,
the two mono banks together occupy approximately 34.0 MB (32.4 MiB). These are manifest-derived estimates;
actual decoded sizes follow the browser's buffers. The music loader retries on the main context if its 32 kHz
offline decoder fails, so that fallback can use more memory.

The score cache target is 128 MiB. Eviction removes unused buffers first, then unused prefetch pins. Playing,
retiring and pending decks retain their buffers, so transitions can temporarily exceed the target; it is not a
hard cap on total Web Audio memory. Runtime telemetry reports actual cache bytes and decode errors.
