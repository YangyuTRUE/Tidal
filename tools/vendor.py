#!/usr/bin/env python3
"""Fetch pinned upstream distributables; run only when intentionally refreshing vendors."""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import hashlib, io, json, tarfile, urllib.request

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'addon/content/vendor'
PACKAGES = {'marked': '12.0.2', 'dompurify': '3.4.17', 'katex': '0.19.1'}

def fetch(spec):
    name, version = spec
    url = f'https://registry.npmjs.org/{name}/-/{name}-{version}.tgz'
    with urllib.request.urlopen(url, timeout=60) as r:
        data = r.read()
    archive = tarfile.open(fileobj=io.BytesIO(data), mode='r:gz')
    saved = []
    for member in archive.getmembers():
        if not member.isfile():
            continue
        rel = member.name.removeprefix('package/')
        target = None
        if name == 'marked' and rel == 'marked.min.js':
            target = DEST / 'marked.min.js'
        elif name == 'dompurify' and rel == 'dist/purify.min.js':
            target = DEST / 'purify.min.js'
        elif name == 'katex' and rel.startswith('dist/') and (
            rel in ['dist/katex.min.js', 'dist/katex.min.css', 'dist/contrib/auto-render.min.js']
            or rel.startswith('dist/fonts/')
        ):
            target = DEST / 'katex' / rel.removeprefix('dist/')
        elif rel in ['LICENSE', 'LICENSE.md', 'LICENSE.txt']:
            target = DEST / f'{name}-LICENSE.txt'
        if target:
            target.parent.mkdir(parents=True, exist_ok=True)
            b = archive.extractfile(member).read()
            target.write_bytes(b)
            saved.append({'path': str(target.relative_to(ROOT)), 'sha256': hashlib.sha256(b).hexdigest()})
    if not saved:
        raise RuntimeError(f'No assets found for {name}')
    return {'name': name, 'version': version, 'url': url, 'archive_sha256': hashlib.sha256(data).hexdigest(), 'files': saved}

if __name__ == '__main__':
    DEST.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(max_workers=3) as pool:
        records = list(pool.map(fetch, PACKAGES.items()))
    (DEST / 'manifest.json').write_text(json.dumps(records, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps([{'name': r['name'], 'version': r['version'], 'files': len(r['files'])} for r in records]))
