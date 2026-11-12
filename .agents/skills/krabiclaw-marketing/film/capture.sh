#!/bin/zsh
# capture.sh <name> <url> [out-dir] [scroll-selector] [scroll-top]
#
# Reference capture of one live dashboard page at phone width, without taking
# the owner's screen. A minimized window in the owner's signed-in Chrome loads
# the page (Chrome keeps running JS in minimized windows but does not paint
# windows that other apps cover, so screen or window-ID captures come back
# blank while the owner works). The page's DOM is saved and rendered at 390 px
# by headless Chromium. Needs Chrome → View → Developer → Allow JavaScript from
# Apple Events.
set -e
name=$1 url=$2 out=${3:-capture} sel=$4 top=$5
here=${0:A:h}
mkdir -p $out/html
winfile=$out/.chrome-window
W=$( [[ -f $winfile ]] && cat $winfile || true )
js() { osascript -e "tell application \"Google Chrome\"
repeat with w in windows
if ((id of w) as text) is \"$W\" then return execute active tab of w javascript \"$1\"
end repeat
error \"capture window $W is gone\"
end tell"; }
if [[ -z $W ]] || ! js "1" >/dev/null 2>&1; then
  W=$(osascript -e 'tell application "Google Chrome"
set w to make new window
set bounds of w to {0, 40, 430, 1000}
set minimized of w to true
return (id of w) as text
end tell')
  echo $W > $winfile
fi
want=${url#https://*/}; want=/${want%%\?*}
js "location.href='$url'" >/dev/null
sleep 2
for i in {1..15}; do
  sleep 2
  r=$(js "(location.pathname==='$want')+':'+document.body.innerText.length")
  [[ $r == true:* && ${r#true:} -gt 80 ]] && break
done
[[ $r == true:* && ${r#true:} -gt 80 ]] || { echo "$name: $want never finished loading ($r)" >&2; exit 1; }
sleep 2.5
js "document.documentElement.outerHTML" > $out/html/$name.html
node $here/render-capture.mjs $out/html/$name.html $out/$name.png "$sel" "$top"
echo $out/$name.png
