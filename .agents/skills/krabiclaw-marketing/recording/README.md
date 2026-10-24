# Screen-recorded product videos

The kit that made the Google Ads OAuth verification video
(https://youtu.be/-ItMxoHlCus, cut list in `examples/`): a real recording of
production in the owner's signed-in Chrome, cut with HyperFrames. Use it for
any video that must show the live product, such as an OpenAI app review demo.

Needs macOS, Google Chrome with View → Developer → Allow JavaScript from Apple
Events on, `cliclick`, `ffmpeg`, Xcode command-line tools (`swiftc`), and
Screen Recording permission for the terminal that runs it.

| File | Does |
| --- | --- |
| `winrec.swift` | Records one Chrome window with ScreenCaptureKit; other windows on top don't appear. `rec.py` builds it on first use. |
| `rec.py` | Opens a 1728×972 (16:9) Chrome window; finds elements by text, moves the real cursor, clicks, types, scrolls, waits; starts and stops recordings. |
| `build.py` | Cut list (`cut.json`) → HyperFrames `index.html`: trimmed and sped-up clips, captions, title and closing cards. |
| `youtube_upload.py` | Puts the MP4 into YouTube Studio's upload field and sets title, description, not-for-kids, Unlisted. |

## Workflow

1. **Script.** One line per scene: what is shown, the caption, the result
   that proves it. Do a dry run off camera (log in, open the pages, check the
   data exists) so the take is one pass.
2. **Record.** One clip per scene, same window throughout:

   ```python
   import rec                                   # REC_DIR=run python3 …
   rec.open_window("https://krabiclaw.com/dashboard/<org>/integrations")
   rec.start("connect")
   rec.click("Connect Google Ads")
   rec.wait_url("https://krabiclaw.com")        # the owner finishes passkey / consent
   rec.click("Save")
   rec.stop()
   ```

   `click` moves the real cursor to the element, then clicks by script; pass
   `real=True` where the page ignores script clicks (Google sign-in,
   ads.google.com). Material menus in Google products need `press_at(x, y)`
   with coordinates read off `shot()`. Passkeys and Google consent are the
   owner's; `wait_url` waits for them.
3. **Convert and pick cuts.** `ffmpeg -i clips/x.mov -vf
   "fps=30,scale=1920:1080:flags=lanczos,format=yuv420p" -c:v libx264 -crf 18
   hf/assets/x.mp4`, then a timestamped contact sheet to choose in and out
   points: `ffmpeg -i hf/assets/x.mp4 -vf
   "fps=1/2,scale=320:-1,drawtext=text='%{pts\:hms}':x=3:y=3:fontsize=22:fontcolor=red:box=1,tile=10x12"
   -frames:v 1 sheet.png`.
4. **Clean account.** Before recording a consent screen, remove any earlier
   Krabiclaw grant from the Google account (myaccount.google.com/connections)
   so the screen lists only the scopes under review; Google treats every scope
   it shows as requested. Don't blur or redact: record from the owner's own
   accounts.
5. **Cut.** Write `cut.json` (format in `build.py`), then `python3 build.py
   cut.json hf/`, `npx hyperframes lint`, `npx hyperframes snapshot --at
   <times> --no-end`, and look at the frames: captions must not cover what the
   scene proves (`"pos": "top"`), small text gets `"zoom"`. Render with `npx
   hyperframes render -o out.mp4 --fps 30 --quality delivery
   --video-frame-format png`.
6. **Approve, then upload.** The owner reviews the MP4 before anything is
   published. Then `python3 youtube_upload.py out.mp4 "<title>" desc.txt
   <channel-id>`. The description lists what each timestamp shows, and
   nothing more: no notes about editing or speed.

## What made the last one work

- Speed waits and typing up 3–6×; hold result screens at 1–1.5×.
- Put each claim beside its proof: the write in the app, then the same
  change in the provider's own UI.
- Re-use a take rather than re-running a flow that needs the owner (passkey,
  consent). Plan scene order so the account ends where it started.
- Close the recording window when done and put the owner's tabs back where
  they were.
- Removing the Krabiclaw grant cuts off every Google integration linked
  through that account (Analytics, Search Console, Ads, Calendar). List them
  first (`organization_integrations` by `account_id`), then Disconnect →
  Connect → pick → save each one and load its leaf to see it reads data.
  Better Auth keeps the old scope list on the account; only a live read
  proves access. Search Console saves with "Connect property", not "Save".
- Before replying to a provider, check the video plays
  (`https://www.youtube.com/oembed?url=<link>`). Reply on the provider's own
  thread: Reply, insert the body with `execCommand('insertText')`, click
  Send once. Gmail can leave the reply box open after sending; the "Message
  sent" toast is the confirmation. Never click Send a second time.
- Replies to reviewers say what changed and what each timestamp shows.
  Nothing about how the video was made.

