"""Drive and record one dedicated window of the owner's signed-in Google Chrome.

Pages are read and clicked through AppleScript `execute javascript`; the real
cursor moves with cliclick so the recording shows it. Run work goes in
REC_DIR (default ./recording-run): clips/<name>.mov, screenshots, scratch JS.

    import rec
    rec.open_window("https://krabiclaw.com/dashboard/...")  # once; sets rec.W
    rec.start("scene-a"); rec.click("Connect Google Ads"); rec.stop()
"""
import json, os, signal, subprocess, time

HERE = os.path.dirname(os.path.abspath(__file__))
S = os.path.abspath(os.environ.get("REC_DIR", "recording-run"))
os.makedirs(f"{S}/clips", exist_ok=True)
W = os.environ.get("CHROME_WINDOW_ID", "")
_recorder = None
# The recording window: 1728x972 points at the top-left, exactly 16:9 below the menu bar.
LEFT, TOP, WIDTH, HEIGHT = 0, 38, 1728, 972


def osa(script):
    r = subprocess.run(["osascript", "-"], input=script, capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(r.stderr)
    return r.stdout.strip()


def open_window(url):
    global W
    W = osa(f'''tell application "Google Chrome"
set w to make new window
set bounds of w to {{{LEFT}, {TOP}, {LEFT + WIDTH}, {TOP + HEIGHT}}}
set URL of active tab of w to "{url}"
activate
return id of w as text
end tell''')
    return W


def js(code):
    with open(f"{S}/_js.js", "w") as f:
        f.write(code)
    return osa(f'''set js to read POSIX file "{S}/_js.js" as «class utf8»
tell application "Google Chrome" to tell active tab of window id {W} to return execute javascript js''')


def url(): return osa(f'tell application "Google Chrome" to return URL of active tab of window id {W}')
def go(u): osa(f'tell application "Google Chrome" to set URL of active tab of window id {W} to "{u}"')
def new_tab(u): osa(f'tell application "Google Chrome" to tell window id {W} to make new tab with properties {{URL:"{u}"}}')
def front(): osa(f'tell application "Google Chrome"\nset index of window id {W} to 1\nactivate\nend tell')


def tab_url(prefix):
    """Make the window's first tab whose URL starts with prefix active."""
    return osa(f'''tell application "Google Chrome"
set i to 0
repeat with t in tabs of window id {W}
set i to i + 1
if URL of t starts with "{prefix}" then
set active tab index of window id {W} to i
return i
end if
end repeat
error "no tab starting with {prefix}"
end tell''')


FIND = r'''
(() => { const want = %s, sel = %s, nth = %d;
 const els = [...document.querySelectorAll(sel)].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (e.innerText || e.value || e.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').includes(want); });
 const e = els.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[nth]; if (!e) return 'null';
 document.querySelectorAll('[data-cc]').forEach(x => delete x.dataset.cc); e.dataset.cc = '1'; e.scrollIntoView({ block: 'center', inline: 'nearest' });
 const r = e.getBoundingClientRect();
 return JSON.stringify({ x: window.screenX + r.left + r.width / 2, y: window.screenY + (window.outerHeight - window.innerHeight) + r.top + r.height / 2 });
})()'''
CLICKABLE = "button,a,[role=button],[role=menuitem],[role=option],[role=tab],input,label,li"


def locate(text, sel=CLICKABLE, nth=0, timeout=20):
    """Screen point of the shortest visible element under sel whose text contains text."""
    end = time.time() + timeout
    while time.time() < end:
        r = js(FIND % (json.dumps(text), json.dumps(sel), nth))
        if r and r != "null":
            return json.loads(r)
        time.sleep(0.5)
    raise RuntimeError(f"not found: {text} in {sel} at {url()}")


def move(x, y): subprocess.run(["cliclick", "-e", "500", f"m:{int(x)},{int(y)}"], check=True)


def click(text, sel=CLICKABLE, nth=0, pause=0.6, timeout=20, real=False):
    """Move the real cursor to the element, then click it: by script, or with the real
    mouse (real=True) for pages that ignore script clicks (Google sign-in, ads.google.com)."""
    locate(text, sel, nth, timeout)
    time.sleep(0.4)  # let scrollIntoView settle
    p = locate(text, sel, nth, timeout)
    move(p["x"], p["y"])
    time.sleep(pause)
    if real:
        front()
        subprocess.run(["cliclick", f"c:{int(p['x'])},{int(p['y'])}"], check=True)
    else:
        js("(()=>{const e=document.querySelector('[data-cc]'); e.focus?.(); for (const t of ['pointerdown','mousedown','pointerup','mouseup']) e.dispatchEvent(new PointerEvent(t,{bubbles:true,cancelable:true,view:window,button:0})); e.click(); return 1})()")


def press_at(sx, sy, shot_width=1400):
    """Real press and release at a point read off a shot() image; Material menus need both."""
    x = int(LEFT + sx * WIDTH / shot_width); y = int(TOP + sy * WIDTH / shot_width)
    move(x, y); time.sleep(0.4); front()
    subprocess.run(["cliclick", f"dd:{x},{y}"], check=True); time.sleep(0.15)
    subprocess.run(["cliclick", f"du:{x},{y}"], check=True)


def typ(t): subprocess.run(["cliclick", "-w", "35", f"t:{t}"], check=True)
def key(k): subprocess.run(["cliclick", f"kp:{k}"], check=True)
def text(): return js("document.body.innerText")


def wait_text(t, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        if t in text():
            return
        time.sleep(0.5)
    raise RuntimeError(f"text not seen: {t} at {url()}")


def wait_url(prefix, timeout=300):
    """Wait for a page the owner finishes (passkey, consent), printing each step."""
    end, last = time.time() + timeout, ""
    while time.time() < end:
        u = url()
        if u.startswith(prefix):
            return u
        if u[:60] != last:
            print(time.strftime("%H:%M:%S"), u[:60]); last = u[:60]
        time.sleep(1)
    raise RuntimeError(f"still at {url()} after {timeout}s")


SCROLLER = "([...document.querySelectorAll('*')].filter(e=>e.scrollHeight>e.clientHeight+50 && /auto|scroll/.test(getComputedStyle(e).overflowY)).sort((a,b)=>b.clientHeight-a.clientHeight)[0] || document.scrollingElement)"


def scroll_to(y, steps=30, dt=0.08):
    """Eased scroll of the page's main scroll container."""
    cur = float(js(f"{SCROLLER}.scrollTop"))
    for i in range(1, steps + 1):
        js(f"{SCROLLER}.scrollTop={cur + (y - cur) * (1 - (1 - i / steps) ** 2)}"); time.sleep(dt)


def scroll_max(): return float(js(f"{SCROLLER}.scrollHeight - {SCROLLER}.clientHeight"))


def shot(name):
    """Screenshot of the window region, plus a 1400-wide copy to read coordinates from."""
    subprocess.run(["screencapture", "-x", "-R", f"{LEFT},{TOP},{WIDTH},{HEIGHT}", f"{S}/{name}.png"], check=True)
    subprocess.run(["sips", "-Z", "1400", f"{S}/{name}.png", "--out", f"{S}/{name}_s.png"], capture_output=True, check=True)
    return f"{S}/{name}_s.png"


def start(name):
    """Record the window to clips/<name>.mov with winrec (built next to this file)."""
    global _recorder
    if _recorder is not None:
        raise RuntimeError("Finish stopping the current recording before starting another.")
    window_id = str(W)
    if not window_id.isdigit() or int(window_id) <= 0:
        raise RuntimeError("Set the recording window with open_window() or CHROME_WINDOW_ID before start().")
    title = osa(f'tell application "Google Chrome" to return name of window id {window_id}')
    if not title:
        raise RuntimeError(f"Recording window {window_id} has no title.")
    binary = f"{HERE}/winrec"
    source = f"{HERE}/winrec.swift"
    if not os.path.exists(binary) or os.path.getmtime(source) > os.path.getmtime(binary):
        subprocess.run(["swiftc", "-O", source, "-o", binary], check=True)
    log = open(f"{S}/clips/{name}.log", "w")
    _recorder = subprocess.Popen([binary, f"{S}/clips/{name}.mov", title], stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    with open(f"{S}/rec.pid", "w") as f:
        f.write(str(_recorder.pid))  # stop() may run in a later process
    end = time.time() + 6
    while time.time() < end:
        out = open(f"{S}/clips/{name}.log").read()
        if "recording" in out.splitlines():
            time.sleep(0.5); return
        if _recorder.poll() is not None:
            raise RuntimeError(out)
        time.sleep(0.2)
    raise RuntimeError("winrec did not start")


def stop():
    global _recorder
    pid = int(open(f"{S}/rec.pid").read())
    status = None
    if _recorder is not None:
        if _recorder.pid != pid:
            raise RuntimeError("The recording changed before it could be stopped.")
        _recorder.send_signal(signal.SIGINT)
        status = _recorder.wait()
        _recorder = None
    else:
        os.kill(pid, signal.SIGINT)
        while True:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.3)
    os.remove(f"{S}/rec.pid")
    if status is not None and status != 0:
        raise RuntimeError(f"winrec exited with status {status}")
