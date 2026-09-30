"""Write data/manifest.json: a content hash for every boundary file the map loads.

Standard library only. The app requests each file as `path?h=<hash>` and keeps it in
Cache Storage under that URL, so a file is downloaded again only when its content
changes, not on every Pages deploy (Pages derives ETags from the deploy time).

Hashes are git blob ids (what `git hash-object` prints), shortened to 12 hex digits.
A file that is tracked but not checked out (sparse clone) keeps the blob id from the
git index, so running this in a partial checkout still writes a complete manifest.

    python3 scripts/build_manifest.py          # rewrite data/manifest.json
    python3 scripts/build_manifest.py --check  # exit 1 if it is out of date
"""

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATTERNS = ("data/states.json", "data/zctas/*.bin", "data/levels/geo/*.bin", "data/levels/geo/cousub/*.bin")


def blob_id(data):
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def tracked():
    """Blob ids from the git index for tracked boundary files ({} outside a git checkout)."""
    try:
        out = subprocess.run(["git", "ls-files", "-s", "--", *PATTERNS], cwd=ROOT, capture_output=True, text=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError):
        return {}
    ids = {}
    for line in out.splitlines():
        meta, path = line.split("\t", 1)
        ids[path] = meta.split()[1]
    return ids


def build():
    files = tracked()
    on_disk = {str(p.relative_to(ROOT)) for pattern in PATTERNS for p in ROOT.glob(pattern)}
    for path in on_disk:
        files[path] = blob_id((ROOT / path).read_bytes())
    return {"files": {path: files[path][:12] for path in sorted(files)}}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    target = ROOT / "data" / "manifest.json"
    text = json.dumps(build(), indent=0, sort_keys=True) + "\n"
    if args.check:
        current = target.read_text() if target.exists() else ""
        if current != text:
            sys.exit("data/manifest.json is out of date; run scripts/build_manifest.py")
        return
    target.write_text(text)
    print(target, len(json.loads(text)["files"]), "files")


if __name__ == "__main__":
    main()
