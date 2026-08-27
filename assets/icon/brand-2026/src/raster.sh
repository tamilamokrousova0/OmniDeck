set -e
cd "$(dirname "$0")"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
shot() { "$CHROME" --headless --disable-gpu --no-sandbox --hide-scrollbars \
    --default-background-color=00000000 --force-device-scale-factor=1 \
    --window-size=$2,$2 --screenshot="$3" "file://$PWD/$1" 2>/dev/null; }
rm -rf png OmniDeck.iconset && mkdir -p png OmniDeck.iconset
shot omnideck-icon-1024.svg 1024 png/1024.png
shot omnideck-icon-small.svg 1024 png/sm-1024.png
for s in 512 256 128 64 48; do sips -Z $s png/1024.png --out png/$s.png >/dev/null; done
for s in 32 24 16;         do sips -Z $s png/sm-1024.png --out png/$s.png >/dev/null; done
cp png/16.png  OmniDeck.iconset/icon_16x16.png
cp png/32.png  OmniDeck.iconset/icon_16x16@2x.png
cp png/32.png  OmniDeck.iconset/icon_32x32.png
cp png/64.png  OmniDeck.iconset/icon_32x32@2x.png
cp png/128.png OmniDeck.iconset/icon_128x128.png
cp png/256.png OmniDeck.iconset/icon_128x128@2x.png
cp png/256.png OmniDeck.iconset/icon_256x256.png
cp png/512.png OmniDeck.iconset/icon_256x256@2x.png
cp png/512.png OmniDeck.iconset/icon_512x512.png
cp png/1024.png OmniDeck.iconset/icon_512x512@2x.png
iconutil -c icns OmniDeck.iconset -o icon.icns
node ico.mjs
echo "icns/ico готовы"
