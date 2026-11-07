#!/usr/bin/env python3
"""Build Tidal's single installable XPI, without fetching dependencies."""
from pathlib import Path
import hashlib, json, re, subprocess, sys, urllib.parse, xml.etree.ElementTree as ET, zipfile

ROOT = Path(__file__).resolve().parents[1]
ADDON = ROOT / 'addon'
DIST = ROOT / 'dist'

def validate_manifest(manifest):
    if manifest.get('manifest_version') != 2:
        raise ValueError('Zotero requires manifest_version 2')
    for field in ['name', 'version', 'description']:
        if not isinstance(manifest.get(field), str) or not manifest[field].strip():
            raise ValueError('Missing manifest field: ' + field)
    zotero = manifest.get('applications', {}).get('zotero', {})
    # Zotero ExtensionData.parseManifest() rejects a missing update_url even
    # when the ZIP and ordinary Firefox WebExtension manifest would be valid.
    for field in ['id', 'update_url', 'strict_min_version', 'strict_max_version']:
        if not isinstance(zotero.get(field), str) or not zotero[field].strip():
            raise ValueError('Missing applications.zotero.' + field)
    update = urllib.parse.urlparse(zotero['update_url'])
    if update.scheme != 'https' or not update.hostname or update.username or update.password:
        raise ValueError('applications.zotero.update_url must be an HTTPS URL')
    if not re.fullmatch(r'[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+|\{[A-Fa-f0-9-]{36}\}', zotero['id']):
        raise ValueError('Invalid Zotero extension ID')

def validate_xpi(path):
    with zipfile.ZipFile(path) as package:
        if package.testzip():
            raise ValueError('XPI CRC failure')
        files = set(package.namelist())
        for required in ['manifest.json', 'bootstrap.js']:
            if required not in files:
                raise ValueError('Missing XPI root/resource entry: ' + required)
        for name in files:
            if name.startswith('/') or '\\' in name or '..' in name.split('/'):
                raise ValueError('Invalid XPI entry path')
        manifest = json.loads(package.read('manifest.json'))
        validate_manifest(manifest)
        for required in ['prefs.js', 'content/core.js', 'content/host.js']:
            if required not in files:
                raise ValueError('Missing XPI resource entry: ' + required)
        for image in manifest.get('icons', {}).values():
            if image not in files:
                raise ValueError('Missing icon in XPI: ' + image)
        return manifest

def build():
    manifest = json.loads((ADDON / 'manifest.json').read_text())
    validate_manifest(manifest)
    if manifest['version'] != json.loads((ROOT / 'package.json').read_text())['version']:
        raise ValueError('package.json and manifest.json versions differ')
    version = manifest['version']
    for filename in ['bootstrap.js', 'prefs.js', 'content/core.js', 'content/host.js', 'content/reader-pane.js', 'content/anchors.js', 'content/appearance.js', 'content/renderer.js', 'content/viewer.js', 'content/history.js', 'content/select-controls.js', 'content/settings.js']:
        subprocess.run(['node', '--check', str(ADDON / filename)], check=True)
    for file in ADDON.rglob('*.xhtml'):
        ET.parse(file)
    # Gecko can retain chrome stylesheet caches after a hot upgrade. Keep the
    # settings document's resource URLs tied to the actual release version.
    for document, resources in {
        'settings': ['settings.css', 'settings.js', 'select-controls.js', 'appearance.css', 'appearance.js'],
        'viewer': ['viewer.css', 'viewer.js', 'core.js', 'appearance.css', 'appearance.js'],
        'history': ['history.css', 'history.js', 'appearance.css', 'appearance.js'],
    }.items():
        resource_urls = {node.get('src') or node.get('href') for node in ET.parse(ADDON / f'content/{document}.xhtml').iter()}
        for filename in resources:
            if f'chrome://tidal/content/{filename}?v={version}' not in resource_urls:
                raise ValueError(f'{document} resource version mismatch: {filename}')
    vendors = json.loads((ADDON / 'content/vendor/manifest.json').read_text())
    for package in vendors:
        for item in package['files']:
            if hashlib.sha256((ROOT / item['path']).read_bytes()).hexdigest() != item['sha256']:
                raise RuntimeError('Vendor hash mismatch: ' + item['path'])
    DIST.mkdir(exist_ok=True)
    xpi = DIST / f'tidal-{version}.xpi'
    def archive(path, files, relative):
        with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
            for file in sorted(files):
                info = zipfile.ZipInfo(str(file.relative_to(relative)), (2026, 11, 6, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                z.writestr(info, file.read_bytes())
        with zipfile.ZipFile(path) as z:
            bad = z.testzip()
            if bad:
                raise RuntimeError('Archive integrity failure: ' + bad)
    addon_files = [file for file in ADDON.rglob('*') if file.is_file() and not file.is_symlink()
                   and not any(part.startswith('.') for part in file.relative_to(ADDON).parts)
                   and file.name.lower() not in ['api.txt', 'secrets.json', 'credentials.json']]
    # Guard against accidentally copying the supplied credential-bearing source or private settings.
    for file in addon_files:
        if 'vendor' in file.parts or file.suffix not in ['.js', '.json', '.xhtml', '.css']:
            continue
        text = file.read_text()
        if re.search(r'sk-[a-f0-9]{20,}|eyJ[A-Za-z0-9_-]{60,}', text):
            raise RuntimeError('Potential embedded credential in ' + file.name)
    staging = DIST / (xpi.name + '.tmp')
    archive(staging, addon_files, ADDON)
    validate_xpi(staging)
    staging.replace(xpi)
    # A successful release replaces previous build products. dist is solely
    # for the installable XPI; validation/checksums live outside it.
    removed = []
    for path in DIST.iterdir():
        if path != xpi and path.is_file() and (path.name.startswith(('paper-translator-', 'tidal-')) or path.name in ['SHA256SUMS.txt', '.DS_Store']):
            removed.append(path.name)
            path.unlink()
    report = {'name': manifest['name'], 'version': version, 'file': 'dist/' + xpi.name,
              'bytes': xpi.stat().st_size, 'sha256': hashlib.sha256(xpi.read_bytes()).hexdigest()}
    reports = ROOT / 'reports'
    reports.mkdir(exist_ok=True)
    (reports / 'release.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({**report, 'removed_previous_artifacts': removed}, indent=2))

if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--check':
        manifest = validate_xpi(Path(sys.argv[2]))
        print(json.dumps({'valid': True, 'id': manifest['applications']['zotero']['id'], 'version': manifest['version']}))
    else:
        build()
