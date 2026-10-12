#!/usr/bin/env -S uv run --script
"""Compare the two latest UI audit manifests and journey outcomes."""
import json
import os
from pathlib import Path

root = Path(os.environ.get("UI_AUDIT_OUTPUT_DIR", Path(__file__).resolve().parents[1] / "artifacts" / "ui-audit")).expanduser()
archives = sorted(root.glob("lantern-ui-audit-*.zip"), key=lambda p: p.stat().st_mtime, reverse=True)
if len(archives) < 2:
    raise SystemExit("Need at least two audit ZIPs in " + str(root))
import zipfile

def load(path):
    with zipfile.ZipFile(path) as archive:
        return json.loads(archive.read("lantern-ui-audit/manifest.json"))

older, newer = load(archives[1]), load(archives[0])
print(f"Older: {archives[1]} ({older['commit'][:12]}, {older['timestamp_utc']})")
print(f"Newer: {archives[0]} ({newer['commit'][:12]}, {newer['timestamp_utc']})")
print("Journey status:")
for viewport in sorted(set(older.get("journey_status", {})) | set(newer.get("journey_status", {}))):
    print(f"  {viewport}: {older.get('journey_status', {}).get(viewport, 'missing')} -> {newer.get('journey_status', {}).get(viewport, 'missing')}")
print(f"Source files: {len(older.get('source_files', []))} -> {len(newer.get('source_files', []))}")
