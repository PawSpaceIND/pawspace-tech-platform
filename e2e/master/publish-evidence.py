"""Copy a master-run's evidence into docs/uat-evidence/master-e2e/run-<N>/ in a compact, reviewable form.

PNG screenshots become JPEGs (max 1100 px wide; very tall full-page shots are capped at 6000 px) so a run
fits comfortably in git; JSON/JSONL/log files are copied as-is; at most a few showcase videos are kept.
Usage: python3 publish-evidence.py <artifacts/master> <run_number>
"""
import os
import shutil
import sys

from PIL import Image

src, run = sys.argv[1], sys.argv[2]
dst = os.path.join("docs", "uat-evidence", "master-e2e", f"run-{run}")
os.makedirs(dst, exist_ok=True)
videos = 0
for root, _, files in os.walk(src):
    for name in sorted(files):
        path = os.path.join(root, name)
        rel = os.path.relpath(path, src)
        out = os.path.join(dst, rel)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        if name.endswith(".png"):
            with Image.open(path) as im:
                im = im.convert("RGB")
                if im.width > 1100:
                    im = im.resize((1100, round(im.height * 1100 / im.width)))
                if im.height > 6000:
                    im = im.crop((0, 0, im.width, 6000))
                im.save(out[:-4] + ".jpg", "JPEG", quality=72, optimize=True)
        elif name.endswith(".webm"):
            if videos < 4 and os.path.getsize(path) < 12_000_000:
                shutil.copyfile(path, out)
                videos += 1
        elif name.endswith((".json", ".jsonl", ".log", ".txt", ".md")):
            shutil.copyfile(path, out)
print(f"published evidence to {dst} ({videos} videos)")
