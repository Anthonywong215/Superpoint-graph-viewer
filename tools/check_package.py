# -*- coding: utf-8 -*-
"""Verify that this folder is a complete, self-consistent, host-safe package.

Run it twice: once before uploading, and once after cloning the repo back down
somewhere else. The second run is the one that matters, because it is the only
thing that proves the data survived the round trip through Git.

Four classes of failure are checked, all of which are silent -- the page still
loads, and only the picture is wrong:

  1. BYTE INTEGRITY.  With core.autocrlf=true -- the Git for Windows default --
     Git rewrites line endings in any file it decides is text.  Doing that to a
     raw buffer shifts every value after the first CR-LF pair.  As the data
     stands no file is at risk, but one of them is safe for a reason that
     depends on its contents rather than its format, so the margin is measured
     here rather than assumed.  See check_binary_classification below.

  2. CASE.  Windows and macOS resolve paths case-insensitively; GitHub Pages
     serves from Linux, which does not.  A reference to Data/manifest.json
     works perfectly on the machine it was written on and 404s once hosted.

  3. MANIFEST AGREEMENT.  Every buffer's size on disk must equal the byte count
     the manifest declares, and that count must equal prod(shape) * itemsize.
     A mismatch means app.js reads a typed array off the end of a buffer.

  4. ROOT-RELATIVE URLS.  A leading slash resolves to the domain root, which is
     correct at http://localhost:PORT/ and wrong at
     https://user.github.io/repo/, where the site lives one directory down.

Exit status is 0 only if every check passes.

    python tools/check_package.py            # verify
    python tools/check_package.py --write    # regenerate data/checksums.sha256
"""
import hashlib
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, 'data')
SUMS = os.path.join(DATA, 'checksums.sha256')

ITEMSIZE = {'float32': 4, 'float64': 8, 'int32': 4, 'uint32': 4,
            'int16': 2, 'uint16': 2, 'int8': 1, 'uint8': 1}

problems = []
notes = []


def fail(check, msg):
    problems.append((check, msg))


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def listdir_exact(d):
    """Real on-disk names, so a case comparison means something on Windows."""
    try:
        return set(os.listdir(d))
    except OSError:
        return set()


def exists_exact(rel):
    """True only if every path segment matches the on-disk spelling exactly."""
    parts = rel.replace('\\', '/').split('/')
    cur = ROOT
    for part in parts:
        if part not in listdir_exact(cur):
            return False
        cur = os.path.join(cur, part)
    return True


# --------------------------------------------------------------------------
# 1. Everything index.html and app.js reach for must exist, spelled the same.
# --------------------------------------------------------------------------
def check_references():
    html = open(os.path.join(ROOT, 'index.html'), encoding='utf-8').read()
    refs = set()
    for m in re.finditer(r'(?:src|href)\s*=\s*"([^"]+)"', html):
        url = m.group(1).split('?')[0].split('#')[0]
        if url and not url.startswith(('http', 'data:', 'mailto:', '#')):
            refs.add(url)

    # app.js fetches data/<name> through the manifest, plus two literals.
    refs.add('data/manifest.json')
    man = json.load(open(os.path.join(DATA, 'manifest.json'), encoding='utf-8'))
    for lvl in man['levels'].values():
        for field in lvl['fields'].values():
            refs.add('data/' + field['file'])
    for key in man.get('overlays', {}):
        refs.add('data/%s.json' % key)

    for rel in sorted(refs):
        if not exists_exact(rel):
            onwin = os.path.exists(os.path.join(ROOT, rel))
            fail('references', '%s is referenced but %s' % (
                rel, 'the on-disk name differs in case (works here, 404s on '
                     'GitHub Pages)' if onwin else 'does not exist'))
    notes.append('%d referenced files resolved, case-exact' % len(refs))
    return man


# --------------------------------------------------------------------------
# 2. Each buffer's real size must match the manifest, twice over.
# --------------------------------------------------------------------------
def check_manifest(man):
    n = 0
    for level, lvl in sorted(man['levels'].items()):
        for name, field in sorted(lvl['fields'].items()):
            path = os.path.join(DATA, field['file'])
            if not os.path.exists(path):
                continue                       # already reported above
            actual = os.path.getsize(path)
            declared = field['bytes']
            if actual != declared:
                fail('manifest', '%s is %d bytes on disk, manifest says %d '
                                 '(a %+d byte drift; app.js would read past '
                                 'the end of the array)'
                     % (field['file'], actual, declared, actual - declared))
            size = ITEMSIZE.get(field['dtype'])
            if size is None:
                fail('manifest', '%s: unknown dtype %r' % (field['file'],
                                                           field['dtype']))
                continue
            expect = size
            for dim in field['shape']:
                expect *= dim
            if expect != declared:
                fail('manifest', '%s: shape %s of %s needs %d bytes, manifest '
                                 'declares %d'
                     % (field['file'], field['shape'], field['dtype'],
                        expect, declared))
            n += 1
    notes.append('%d buffers agree with the manifest on size, shape and dtype'
                 % n)


# --------------------------------------------------------------------------
# 3. Byte-for-byte integrity across the Git round trip.
# --------------------------------------------------------------------------
def binary_files():
    return sorted(f for f in os.listdir(DATA) if f.endswith('.bin'))


def write_sums():
    lines = ['# SHA-256 of every binary payload, written by '
             'tools/check_package.py --write.',
             '# Re-run tools/check_package.py after cloning to prove the data '
             'survived Git.', '']
    for f in binary_files():
        lines.append('%s  %s' % (sha256(os.path.join(DATA, f)), f))
    open(SUMS, 'w', encoding='utf-8', newline='\n').write('\n'.join(lines) + '\n')
    print('wrote %s (%d files)' % (os.path.relpath(SUMS, ROOT),
                                   len(binary_files())))


def check_sums():
    if not os.path.exists(SUMS):
        fail('checksums', 'data/checksums.sha256 is missing; run '
                          'python tools/check_package.py --write')
        return
    recorded = {}
    for line in open(SUMS, encoding='utf-8'):
        line = line.strip()
        if line and not line.startswith('#'):
            digest, name = line.split(None, 1)
            recorded[name.strip()] = digest
    on_disk = set(binary_files())
    for name in sorted(set(recorded) | on_disk):
        if name not in recorded:
            fail('checksums', '%s is not listed in checksums.sha256' % name)
        elif name not in on_disk:
            fail('checksums', '%s is listed in checksums.sha256 but missing'
                 % name)
        elif sha256(os.path.join(DATA, name)) != recorded[name]:
            fail('checksums', '%s does not match its recorded SHA-256. If this '
                              'is a fresh clone, .gitattributes was missing or '
                              'ignored and Git has rewritten the file.' % name)
    notes.append('%d binary payloads match their recorded SHA-256' % len(on_disk))


def git_is_binary(blob):
    """Reimplementation of gather_stats() and is_binary() from Git's convert.c.

    This is the code path that governs CRLF rewriting, and it is not the same
    as buffer_is_binary(), which only governs diff.  Two differences matter:
    it reads the whole file rather than the first 8000 bytes, and a file with
    no NUL byte can still be accepted as binary on a ratio of unprintable to
    printable characters.  Note that bytes >= 128 count as PRINTABLE here, so
    the ratio is decided by how many bytes fall below 32.

    Returns (is_binary, nonprintable, threshold).
    """
    nul = printable = nonprintable = 0
    i, n = 0, len(blob)
    while i < n:
        c = blob[i]
        if c == 13:                       # CR, with its LF if it has one
            i += 2 if (i + 1 < n and blob[i + 1] == 10) else 1
            continue
        if c == 10:                       # LF
            i += 1
            continue
        if c == 127:
            nonprintable += 1
        elif c < 32:
            if c == 0:
                nul += 1
                nonprintable += 1
            elif c in (8, 9, 12, 27):     # \b \t \f ESC are counted printable
                printable += 1
            else:
                nonprintable += 1
        else:
            printable += 1
        i += 1
    if nul:
        return True, nonprintable, 0
    return (printable >> 7) < nonprintable, nonprintable, printable >> 7


def check_binary_classification():
    """What Git would do to each buffer if .gitattributes were not there."""
    ga = os.path.join(ROOT, '.gitattributes')
    if not os.path.exists(ga):
        fail('gitattributes', '.gitattributes is missing; the payload is then '
                              'at the mercy of a content heuristic.')
    else:
        text = open(ga, encoding='utf-8').read()
        if not re.search(r'^\s*\*\.bin\s+(binary|-text)\b', text, re.M):
            fail('gitattributes', '.gitattributes does not mark *.bin binary.')

    unprotected, thin = [], []
    for f in binary_files():
        blob = open(os.path.join(DATA, f), 'rb').read()
        ok, nonpr, threshold = git_is_binary(blob)
        if not ok:
            unprotected.append(f)
        elif threshold:                   # survived on the ratio, not on a NUL
            thin.append((f, nonpr, threshold))

    if unprotected:
        fail('gitattributes', 'Git would classify %s as text. The rules in '
                              '.gitattributes are now the only thing keeping '
                              '%s intact -- do not remove them.'
             % (', '.join(unprotected), 'it' if len(unprotected) == 1 else 'them'))
    notes.append('%d of %d payloads carry NUL bytes and Git reads them as '
                 'binary unconditionally' % (len(binary_files()) - len(thin),
                                             len(binary_files())))
    for f, nonpr, threshold in thin:
        notes.append('%s has no NUL byte and is classified binary only by the '
                     'ratio test: %d unprintable against a threshold of %d '
                     '(margin x%.1f). .gitattributes removes this dependency '
                     'on the pixel values.' % (f, nonpr, threshold,
                                               nonpr / max(threshold, 1)))


# --------------------------------------------------------------------------
# 4. Nothing may be addressed from the domain root.
# --------------------------------------------------------------------------
def check_relative_urls():
    hits = 0
    for name in ('index.html', 'app.js', 'style.css'):
        path = os.path.join(ROOT, name)
        for i, line in enumerate(open(path, encoding='utf-8'), 1):
            for m in re.finditer(r'(?:src|href|url)\s*[=(]\s*["\']?(/[^/"\'\s)]+)',
                                 line):
                fail('urls', '%s:%d addresses %s from the domain root; on '
                             'GitHub Pages the site is served from '
                             '/<repo>/ and this will 404'
                     % (name, i, m.group(1)))
                hits += 1
    if not hits:
        notes.append('no root-relative URLs; the page works from any subpath')


def report_size():
    total = files = 0
    for base, dirs, names in os.walk(ROOT):
        dirs[:] = [d for d in dirs if d not in ('.git', '__pycache__')]
        for n in names:
            total += os.path.getsize(os.path.join(base, n))
            files += 1
    big = [(f, os.path.getsize(os.path.join(base, f)))
           for base, _, fs in os.walk(ROOT) for f in fs
           if os.path.getsize(os.path.join(base, f)) > 50 * 1024 * 1024]
    for f, s in big:
        fail('size', '%s is %.0f MB; GitHub warns above 50 MB and refuses '
                     'above 100 MB' % (f, s / 1e6))
    notes.append('%d files, %.1f MB total (GitHub Pages soft limit is 1 GB)'
                 % (files, total / 1e6))


def main():
    if '--write' in sys.argv:
        write_sums()
        return 0

    man = check_references()
    check_manifest(man)
    check_binary_classification()
    check_sums()
    check_relative_urls()
    report_size()

    for n in notes:
        print('  ok    %s' % n)
    if problems:
        print()
        for check, msg in problems:
            print('  FAIL  [%s] %s' % (check, msg))
        print('\n%d problem(s). Do not upload until these are fixed.'
              % len(problems))
        return 1
    print('\nPackage is complete, self-consistent and safe to host.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
