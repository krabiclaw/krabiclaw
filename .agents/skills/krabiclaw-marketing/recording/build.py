"""Write a HyperFrames index.html from a cut list of real recordings, text cards and captions.

    python3 build.py cut.json hf/      # clips are read from hf/assets/

cut.json: {"title": "...", "width": 1920, "height": 1080, "segments": [...]}; width and
height default to 1080p and should match the recordings. A segment is either
  {"kind": "card", "dur": 7, "html": "<h1>…</h1>"}  or
  {"kind": "video", "src": "a.mp4", "from": 3, "to": 16, "rate": 2,
   "tag": "read", "cap": "What this shows", "pos": "top", "zoom": "transform:scale(1.7);transform-origin:28% 96%;"}
Duration of a video segment is (to - from) / rate. Prints each segment's start for the description.
"""
import html, json, sys

cut = json.load(open(sys.argv[1]))
width, height = cut.get("width", 1920), cut.get("height", 1080)
cap_top = cut.get("cap_top", 120)  # px from the top for "pos": "top" captions
out_dir = sys.argv[2]
parts, tweens, t = [], [], 0.0
for i, s in enumerate(cut["segments"]):
    sid = f"s{i}"
    if s["kind"] == "card":
        d = s["dur"]
        parts.append(f'<section id="{sid}" class="clip card" data-start="{t:.3f}" data-duration="{d:.3f}" data-track-index="0"><div class="card-inner" id="{sid}-in">{s["html"]}</div></section>')
        tweens.append(f'tl.fromTo("#{sid}-in", {{opacity:0, y:24}}, {{opacity:1, y:0, duration:0.5, ease:"power2.out"}}, {t + 0.1:.3f});')
    else:
        rate = s.get("rate", 1)
        d = (s["to"] - s["from"]) / rate
        zoom = s.get("zoom", "")
        parts.append(f'<video id="{sid}" class="clip shot" style="{zoom}" src="assets/{s["src"]}" muted playsinline data-start="{t:.3f}" data-duration="{d:.3f}" data-media-start="{s["from"]:.3f}" data-playback-rate="{rate}" data-track-index="0"></video>')
        if s.get("cap"):
            pos = " top" if s.get("pos") == "top" else ""
            tag = f'<span class="tag">{html.escape(s["tag"])}</span>' if s.get("tag") else ""
            parts.append(f'<div id="{sid}-cap" class="clip cap{pos}" data-start="{t:.3f}" data-duration="{d:.3f}" data-track-index="1"><div class="cap-inner" id="{sid}-ci">{tag}{html.escape(s["cap"])}</div></div>')
            tweens.append(f'tl.fromTo("#{sid}-ci", {{opacity:0, y:16}}, {{opacity:1, y:0, duration:0.35}}, {t + 0.15:.3f});')
    print(f"{int(t // 60)}:{int(t % 60):02d}  {s.get('tag', s['kind'])}  {s.get('cap', '')[:70]}")
    t += d

with open(f"{out_dir}/index.html", "w") as f:
    f.write(f'''<!doctype html>
<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width={width}, height={height}" />
<title>{html.escape(cut["title"])}</title>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>
body {{ margin:0; background:#0b1020; color:#fff; font-family: system-ui, -apple-system, sans-serif; }}
#root {{ position:relative; width:100%; height:100%; overflow:hidden; background:#0b1020; }}
.shot {{ position:absolute; inset:0; width:100%; height:100%; object-fit:contain; background:#0b1020; }}
.card {{ position:absolute; inset:0; display:flex; align-items:center; justify-content:center; background:#0b1020; }}
.card-inner {{ width:1500px; }}
.card h1 {{ font-size:84px; margin:0 0 12px; font-weight:700; letter-spacing:-1px; }}
.card h2 {{ font-size:40px; margin:0 0 48px; font-weight:400; color:#aab4d0; }}
.card .row {{ font-size:30px; color:#aab4d0; margin:18px 0 6px; }}
.card .mono {{ font-family: ui-monospace, Menlo, monospace; font-size:34px; color:#fff; background:#18213d; padding:14px 22px; border-radius:12px; display:inline-block; }}
.card p {{ font-size:40px; line-height:1.45; margin:0 0 26px; color:#e6eaf5; }}
.card .accent {{ color:#ff6b57; }}
.cap {{ position:absolute; left:0; right:0; bottom:48px; display:flex; justify-content:center; pointer-events:none; }}
.cap.top {{ bottom:auto; top:{cap_top}px; }}
.cap-inner {{ font-size:34px; line-height:1.3; background:rgba(11,16,32,0.92); color:#fff; padding:16px 28px; border-radius:14px; max-width:1600px; box-shadow:0 8px 30px rgba(0,0,0,.35); }}
.tag {{ display:inline-block; font-family: ui-monospace, Menlo, monospace; font-size:26px; background:#ff6b57; color:#0b1020; padding:4px 12px; border-radius:8px; margin-right:16px; vertical-align:2px; font-weight:700; }}
</style></head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-width="{width}" data-height="{height}" data-duration="{t:.3f}">
{chr(10).join(parts)}
</div>
<script>
const tl = gsap.timeline({{ paused: true }});
{chr(10).join(tweens)}
window.__timelines["main"] = tl;
</script></body></html>''')
print(f"total {t:.1f}s")
