"""Upload an MP4 to the YouTube Studio channel signed in to the recording window, unlisted.

    REC_DIR=… CHROME_WINDOW_ID=… python3 youtube_upload.py video.mp4 "Title" description.txt <channel-id>

The file goes into Studio's own upload field in 1.5 MB base64 pieces, so no OS file
dialog or keyboard is needed. Prints the video link. Uploading publishes: run it
only when the owner has approved the cut and the destination.
"""
import base64, json, sys, time
import rec

path, title, desc_file, channel = sys.argv[1:5]
description = open(desc_file).read()
rec.new_tab(f"https://studio.youtube.com/channel/{channel}/videos/upload?d=ud")
rec.tab_url("https://studio.youtube.com")
time.sleep(8)
if rec.js("String(!!document.querySelector('input[type=file]'))") != "true":
    raise SystemExit(f"no upload field at {rec.url()}")

data = base64.b64encode(open(path, "rb").read()).decode()
rec.js("window.__vc = []; 'ok'")
for i in range(0, len(data), 1_500_000):
    rec.js(f"window.__vc.push('{data[i:i + 1_500_000]}'); window.__vc.length")
print(rec.js("""(()=>{const b=atob(window.__vc.join('')); const u=new Uint8Array(b.length); for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i);
const f=new File([u], 'video.mp4', {type:'video/mp4'}); const dt=new DataTransfer(); dt.items.add(f);
const inp=document.querySelector('input[type=file][name=Filedata]')||document.querySelector('input[type=file]');
inp.files=dt.files; inp.dispatchEvent(new Event('change',{bubbles:true})); window.__vc=null; return 'uploading '+f.size+' bytes'})()"""))
time.sleep(10)

print(rec.js(f"""(()=>{{const tb=[...document.querySelectorAll('#textbox[contenteditable=true]')];
tb[0].innerText={json.dumps(title)}; tb[0].dispatchEvent(new Event('input',{{bubbles:true}}));
tb[1].innerText={json.dumps(description)}; tb[1].dispatchEvent(new Event('input',{{bubbles:true}}));
const kids=document.querySelector('tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]'); kids.click();
return JSON.stringify([tb[0].innerText, tb[1].innerText.length, kids.getAttribute('aria-checked')])}})()"""))
for _ in range(3):
    rec.js("document.querySelector('#next-button').click()"); time.sleep(3)
print("unlisted:", rec.js("(()=>{const r=document.querySelector('tp-yt-paper-radio-button[name=UNLISTED]'); r.click(); return r.getAttribute('aria-checked')})()"))
time.sleep(2)
link = rec.js("(()=>{const a=[...document.querySelectorAll('a')].find(a=>/youtu\\.be\\//.test(a.href)); return a?a.href:''})()")
rec.js("document.querySelector('#done-button').click()")
print("link:", link)
