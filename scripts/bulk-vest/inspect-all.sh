#!/bin/bash
set -e

# Run visual inspection for all published states and generate HTML gallery
# Usage: ./scripts/bulk-vest/inspect-all.sh [--state XX] [--check-splits]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CSV_FILE="$SCRIPT_DIR/states.csv"
SCREENSHOTS_DIR="$SCRIPT_DIR/screenshots"

FILTER_STATE=""
EXTRA_ARGS=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --state) FILTER_STATE="$2"; shift 2 ;;
    --check-splits) EXTRA_ARGS="$EXTRA_ARGS --check-splits"; shift ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# Get published states from CSV
python3 -c "
import csv
with open('$CSV_FILE') as f:
    reader = csv.DictReader(f)
    seen = set()
    for row in reader:
        state = row['state_abbr']
        status = row['status']
        if status == 'published' and state not in seen:
            if '$FILTER_STATE' and state != '$FILTER_STATE':
                continue
            seen.add(state)
            print(state)
" | while read -r state; do
  echo "=== Inspecting $state ==="
  npx ts-node "$SCRIPT_DIR/visual-inspect.ts" --state "$state" $EXTRA_ARGS || {
    echo "FAILED: $state"
    continue
  }
done

echo ""
echo "All inspections complete. Generating gallery..."

# Generate HTML gallery
python3 -c "
import os
import glob

screenshots_dir = '$SCREENSHOTS_DIR'
if not os.path.isdir(screenshots_dir):
    print('No screenshots directory found')
    exit(0)

states = sorted([d for d in os.listdir(screenshots_dir)
                 if os.path.isdir(os.path.join(screenshots_dir, d))])

if not states:
    print('No state screenshot directories found')
    exit(0)

html = '''<!DOCTYPE html>
<html>
<head>
<meta charset=\"utf-8\">
<title>DistrictBuilder Visual Inspection Gallery</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 20px; background: #f5f5f5; }
  h1 { color: #333; }
  .nav { position: sticky; top: 0; background: #fff; padding: 10px; margin-bottom: 20px;
         border-radius: 4px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); z-index: 10; }
  .nav a { margin-right: 8px; text-decoration: none; color: #0066cc; font-size: 14px; }
  .nav a:hover { text-decoration: underline; }
  .state { margin-bottom: 40px; background: #fff; padding: 20px; border-radius: 8px;
           box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .state h2 { margin-top: 0; color: #333; border-bottom: 2px solid #eee; padding-bottom: 8px; }
  .screenshots { display: grid; grid-template-columns: repeat(auto-fill, minmax(450px, 1fr));
                 gap: 12px; }
  .screenshot { text-align: center; }
  .screenshot img { width: 100%; border: 1px solid #ddd; border-radius: 4px; cursor: pointer; }
  .screenshot img:hover { box-shadow: 0 2px 8px rgba(0,0,0,0.2); }
  .screenshot .label { font-size: 12px; color: #666; margin-top: 4px; }
  .fullscreen { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%;
                background: rgba(0,0,0,0.9); z-index: 100; cursor: pointer;
                justify-content: center; align-items: center; }
  .fullscreen img { max-width: 95%; max-height: 95%; object-fit: contain; }
  .fullscreen.active { display: flex; }
</style>
</head>
<body>
<h1>Visual Inspection Gallery</h1>
<div class=\"nav\">'''

# Navigation links
for state in states:
    html += f'<a href=\"#{state}\">{state}</a> '

html += '</div>'

# State sections
for state in states:
    state_dir = os.path.join(screenshots_dir, state)
    pngs = sorted(glob.glob(os.path.join(state_dir, '*.png')))
    if not pngs:
        continue

    html += f'<div class=\"state\" id=\"{state}\"><h2>{state}</h2><div class=\"screenshots\">'
    for png in pngs:
        fname = os.path.basename(png)
        label = fname.replace('.png', '').replace(f'{state}_', '')
        rel_path = f'{state}/{fname}'
        html += f'''<div class=\"screenshot\">
          <img src=\"{rel_path}\" alt=\"{fname}\" onclick=\"showFull(this.src)\" loading=\"lazy\">
          <div class=\"label\">{label}</div>
        </div>'''
    html += '</div></div>'

html += '''
<div class=\"fullscreen\" id=\"fullscreen\" onclick=\"this.classList.remove('active')\">
  <img id=\"fullImg\" src=\"\">
</div>
<script>
function showFull(src) {
  document.getElementById('fullImg').src = src;
  document.getElementById('fullscreen').classList.add('active');
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') document.getElementById('fullscreen').classList.remove('active');
});
</script>
</body></html>'''

gallery_path = os.path.join(screenshots_dir, 'index.html')
with open(gallery_path, 'w') as f:
    f.write(html)
print(f'Gallery generated: {gallery_path}')
"

echo "Review screenshots at: $SCREENSHOTS_DIR/index.html"
