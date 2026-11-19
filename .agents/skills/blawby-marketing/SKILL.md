---
name: blawby-marketing
description: Make Blawby marketing and feature videos the owner-approved way, modeled on Airbnb's host feature tours. The script follows Airbnb's narration line for line, the voice is local Kokoro, and the real dashboard UI is rebuilt in HyperFrames from live captures. Use for marketing videos and feature media for blogs and help docs. For screen-recorded proof such as app-review or OAuth demos, use recording/.
---

# Blawby marketing video

Approved 2026-11-10 with the Cedar Legal consultations film, and again 2026-11-17 with its Blawby rebuild (`consultations-film-blawby-v4.mp4`, 1:45), which set the wide camera below. This file records the method that produced it. Change this file only after the owner approves a new output; the approved output is what this skill encodes.

Read [product-profile.md](product-profile.md) for product facts, voice and brand. Check a capability in the product itself before claiming it. Install the HyperFrames skills with `npx skills add heygen-com/hyperframes --all`.

## The model: Airbnb

The model is Airbnb's "New Tools for Hosting Your Home on Airbnb" (2:01). Watch it before writing anything. Its traits are the spec:

- The narrator talks to the viewer ("you"), names each tool and says where to tap.
- One point of view: the host. For us that is the business (the attorney, host, chef or guide), never the client's phone.
- The frame is 16:9. A phone sits on white space and the camera stays on the whole phone. Airbnb is wide about 80% of the time and pushes in only 4–5 times in 2 minutes.
- The UI animates itself. Counters roll, sheets rise, rows reorder and the keyboard types. Nothing is a screen recording.
- The film ends on a summary line, then the logo on white.

## Script

Take Airbnb's narration line by line and keep their words. Change only the nouns and the places where our product works differently ("hosting" → "practicing", "reservations" → "consultations"). The owner rejected a script written in our own words as "ai bullshit".

Write a table with Airbnb's line, our line and the real screen that shows it. Before keeping a line, check in code (`utils/vertical-copy.ts`, `i18n/locales/en.ts`, the page or component) that the screen and every label exist. A line with no screen behind it is cut until the feature exists. Never draw UI the product doesn't have. If an Airbnb line points to a feature we lack and the owner wants it, that is product work for every vertical (see the feature-parity rule), not something the video draws.

Use fictional people and numbers that agree with each other: 14 paid consultations at $80 is $1,120, and the funnel steps add up. Use the vertical's vocabulary from `utils/vertical-copy.ts`.

## Voice

Use Kokoro `af_heart`, run locally. Audio is not an approval step: generate it, transcribe it to check, normalize it and move on.

- **Setup:** `npx hyperframes tts "<line>" -v af_heart -o NN.wav`, with `HYPERFRAMES_PYTHON` pointing at a venv that has `kokoro-onnx soundfile`.
- **Brand name:** "Blawby" as spelled; Kokoro says it correctly. Whisper hears "Blobby" unless it is given `--initial_prompt Blawby`.
- **One file per line:** split a line where the picture needs a pause. If Kokoro runs two clauses together ("Jordan accepts, and your calendar…"), voice them as separate clips.
- **Checks:** transcribe each file (Whisper `base.en` with `--word_timestamps True`) to confirm the words and to time taps to them. Normalize each file to −16 LUFS / −1.5 dBTP with ffmpeg `loudnorm`.

## UI references

Rebuild screens from captures of the real dashboard at phone width (390 px), never from memory. [`film/capture.sh`](film/capture.sh) `<name> <url> [out-dir]` loads the page in a minimized window of the owner's signed-in Chrome, saves its DOM and renders it headless with [`film/render-capture.mjs`](film/render-capture.mjs).

It never takes the owner's screen. Chrome does not paint windows that other apps cover, so screen-region and window-ID captures come back blank or show the owner's other apps. Use the showcase tenant for the vertical (Cedar Legal, `cedar-legal-demo`, for legal). It lives on production; the `.env` CANARY login owns it, so headless Playwright signed in with that login captures it directly. Staging does not accept that login. Check the screens against the code on `staging` too: a release can change a screen the capture shows.

Bugs found while capturing are product work: report them or fix them at the source. Don't reproduce a production bug in the film, and don't use the film to hide one.

## Building it in HyperFrames

Read the [HyperFrames skill](../hyperframes/SKILL.md) for the contract. The layout:

- **Project:** 1920×1080, 30 fps. One scene per script beat in `compositions/`. The icon sprite (Lucide paths) and every `<audio>` clip live in `index.html`.
- **Shared look:** [`film/ui.css`](film/ui.css) holds the phone (414×868 graphite bezel, 390×844 screen), Poppins 400–700 from `@fontsource/poppins`, and the dashboard tokens read from the live page's computed `--ui-*` values: page `#ffffff`, ink `#1f2547`, text `#454864`, muted `#5b5e73`, border `#ebebeb`, muted surface `#f7f7f7`, accented `#f0f0f0`, coral `#ee4237`. Re-read them after a brand change. Copy it and the fonts into `assets/`. Each scene links it and styles its own root as `#root` with a white ground.
- **Camera:** one `.cam` wrapper per scene, moved with `F(sx, sy, s) = { x: 960 − (765 + sx)·s, y: 540 − (118 + sy)·s, scale: s }`, where `(sx, sy)` is a point on the 390×844 screen. Rest is `F(195, 422, 1)`, the whole phone, and the film sits there. Push in about four times in a two-minute film, to 1.5–1.6 on `power2.inOut` over 0.8–1.2 s, held for the whole line: the opening (start pushed in on the heading and settle to rest), something being typed, the one suggestion or setting the line is about, and the moment a choice is made. Never move the camera to follow a screen change.
- **Screens:** every screen of a scene is a layer in the one still phone, `.scr` with `isolation: isolate` so its own z-indexes stay inside it. A screen opened from a row pushes in from the right (x 390 → 0, 0.4 s `power3.out`); a sheet rises from below over a dark scrim; the keyboard rises with typing. Generate the scenes from one builder script so the phone, tab bar, sheets and cards are the same markup everywhere, and edit the builder rather than the generated files.
- **Taps:** a 0.12 s background darkening on the pressed row, placed on the spoken word; a filled button presses in to 0.94 scale and back instead, keeping its colour. No cursor and no click rings.
- **Other motion:** sheets rise on `expo.out` and fall on `power3.in`. Text swaps blur 8 px → 0. Times roll like a slot machine, and counters count up.
- **Tween state:** use `fromTo` with `immediateRender: false` on every tween after the first one on a property, and set baselines with `tl.set(…, 0)` for anything tweened more than once.

Pacing:

- A beat may run up to 15 s. Give each narrated line its own screen, held long enough to read.
- Leave gaps between lines rather than speeding the UI up.
- Cut between scenes on the tap that leads there; the next scene opens on the screen it leads to.
- A hold while the narrator explains what is on screen is deliberate: mark the element `data-hold`.

The ending: the phone scales to 0.92 and fades on the brand name, then the Blawby shield (`public/platform/blawby.svg`) lands on white and holds for about 2 s. Use the mark alone, with no wordmark next to it.

No captions are burned into the picture; make a subtitle track if one is needed. Add a quiet music bed only after the picture is approved, as Airbnb's film has. Take it from the YouTube Studio Audio Library of the Blawby channel, opened through the owner's Chrome as above: choose an instrumental with no vocals, longer than the film, whose license reads "No attribution is required", and record the title, artist and license next to the file. Mix it at −26 LUFS under the −16 LUFS voice (about 14 dB below, as Airbnb's), fade in over about 1 s and out over the last 3 s. No sound effects.

## Checking and delivery

- **During the build:** run `npx hyperframes check --json` and fix every error. The text_occluded and content_overlap errors caused by a screen deliberately stacked under a sheet are expected: confirm them in a snapshot, then mark the covering element `data-layout-allow-occlusion` and the screen beneath it `data-layout-allow-overlap`.
- **Before showing anything:** look at `snapshot --at …` sheets of every tap and seam. Then render, sample the MP4 (`ffmpeg -vf fps=1/2,tile`) and transcribe it.
- **Approval:** the owner approves the look on a ~15 s style test before the rest of the film is built.
- **Camera check:** sample the render at 1 fps and count the pushed-in frames: around a fifth of the film at most, as Airbnb's.

Deliver the export path and the editable project. Uploading or publishing needs the owner's instruction for that exact content and destination. Publish through the [MCP](../../../docs/mcp.md) and [media workflow](../../../docs/media-workflow-contract.md) contracts with a poster, and read back the result.
