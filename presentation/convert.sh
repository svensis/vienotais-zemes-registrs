#!/bin/zsh
export PATH="/opt/homebrew/bin:$PATH"
# webm → H.264 mp4 (PowerPoint webm neatskaņo). Nogriež ielādes sākumu
# pēc <klips>.json, izveido arī plakātu (pirmais + vidus kadrs).
# Lietojums: ./convert.sh klikskis slani ...
cd "$(dirname "$0")"
mkdir -p clips posters
for name in "$@"; do
  meta="clips/raw/$name.json"
  [ -f "$meta" ] || { echo "nav $meta"; continue; }
  src=$(python3 -c "import json;print(json.load(open('$meta'))['file'])")
  from=$(python3 -c "import json;print(max(0,json.load(open('$meta'))['trimFrom']-0.3))")
  ffmpeg -y -loglevel error -ss "$from" -i "$src" \
    -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -movflags +faststart -an \
    -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=30" "clips/$name.mp4"
  dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "clips/$name.mp4")
  ffmpeg -y -loglevel error -ss "$(python3 -c "print(float('$dur')*0.45)")" -i "clips/$name.mp4" -frames:v 1 "posters/$name.png"
  echo "$name: ${dur}s"
done
