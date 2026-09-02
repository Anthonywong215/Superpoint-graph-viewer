# -*- coding: utf-8 -*-
"""Export the saved NAG (isar_spg.h5) into flat binary buffers the website
can fetch() and render directly, with no server-side processing at view time.

Why not read the .h5 from the browser: h5py needs a Python runtime, and the
file is 352 MB with fields (KNN tables, 33 scalar channels) the viewer never
uses. This script keeps only what is drawn, decimates level 0 to a browser-
friendly point budget, and writes each array as a raw little-endian buffer
next to a manifest.json that says how to interpret it.

Two things are computed here rather than copied from the h5, because the raw
columns would be wrong for them:

  * The per-voxel class label is REBUILT from Change_Code and is_transformed
    (dead band 0.25), not read from Class5_Code -- averaging the ordinal
    Class5_Code during voxelisation invents classes that do not exist. This
    is the same rule notebook 004 cell A1 and Chapter 3 Sec. 3.6.4 use.
  * Level 1-3 units get a MAJORITY label and a PURITY, aggregated from that
    rebuilt voxel label through the super_index chain P0 -> P1 -> P2 -> P3 --
    the same chain make_method_figures.py's fig_partition() walks, and the
    same purity definition Chapter 3's purity-gate figure reports.

Run from anywhere with h5py + numpy (no torch needed):
    python tools/export_nag.py
    python tools/export_nag.py --h5 /path/to/isar_spg.h5
"""
import json
import os
import sys

import h5py
import numpy as np

# Where the source NAG lives. The defaults are the layout of the thesis working
# tree, where this folder sits inside 000_Thesis/ next to the partition. Once
# the viewer is published on its own those directories are not there, and the
# 352 MB .h5 is not in the repository either -- it is far too large for Git and
# is archived separately. So both inputs can be overridden, and the script says
# what it was looking for rather than dying on a stack trace.
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
_ISAR = os.path.join(ROOT, 'SPT_anthony', 'superpoint_transformer-master',
                     'data', 'isar')


def _opt(flag, env, default):
    """Command-line flag, else environment variable, else the thesis-tree path."""
    if flag in sys.argv:
        return sys.argv[sys.argv.index(flag) + 1]
    return os.environ.get(env) or default


H5 = _opt('--h5', 'NAG_H5', os.path.join(_ISAR, 'isar_spg.h5'))
CFG = _opt('--config', 'NAG_CONFIG', os.path.join(_ISAR, 'partition_config.json'))
OUT = _opt('--out', 'NAG_OUT', os.path.join(os.path.dirname(HERE), 'data'))

if not os.path.exists(H5):
    sys.exit("""Cannot find the source NAG.

  looked for: %s

The .h5 is roughly 352 MB and is deliberately not in this repository.
Point the script at your own copy, either way round:

  python tools/export_nag.py --h5 PATH/isar_spg.h5
  NAG_H5=PATH/isar_spg.h5 python tools/export_nag.py
""" % H5)

DEADBAND = 0.25          # Sec. 3.6.4: |Change_Code| below this -> no direction
GATE_PURITY, GATE_MIN_VOX = 0.80, 10          # the purity gate, Sec. 3.9.5
LEVEL0_BUDGET = 150_000  # points drawn for P0; the other levels are used whole
SEED = 0                 # matches the random seed used throughout the thesis figures

CLASS_NAMES = ['No significant change', 'Deposition — stable',
               'Deposition — transformed', 'Erosion — stable',
               'Erosion — transformed']
# identical to CLASS_COL in make_method_figures.py, so the viewer never
# disagrees with a printed figure about what a colour means
CLASS_COLORS = ['#9E9E9E', '#90CAF9', '#1565C0', '#EF9A9A', '#C62828']


def write_bin(name, arr):
    path = os.path.join(OUT, name)
    np.ascontiguousarray(arr).tofile(path)
    return {'file': name, 'dtype': str(arr.dtype), 'shape': list(arr.shape),
            'bytes': int(arr.nbytes)}


def rebuild_class(change_code, is_transformed):
    t = is_transformed > 0.5
    pos = change_code > DEADBAND
    neg = change_code < -DEADBAND
    return np.select([t & ~neg, t & neg, pos, neg], [2, 4, 1, 3], default=0
                     ).astype(np.uint8)


def majority_and_purity(owner, label, n_units):
    """For every unit 0..n_units-1: majority label, purity, member count."""
    tab = np.zeros((n_units, 5), np.int64)
    np.add.at(tab, (owner, label.astype(np.int64)), 1)
    n = tab.sum(1)
    maj = tab.argmax(1).astype(np.uint8)
    pur = np.divide(tab.max(1), np.maximum(n, 1), dtype=np.float32)
    return maj, pur, n.astype(np.int32)


def main():
    os.makedirs(OUT, exist_ok=True)
    cfg = json.load(open(CFG, encoding='utf-8')) if os.path.exists(CFG) else {}
    manifest = {
        'source': os.path.basename(H5),
        'ply_offset': cfg.get('ply_offset', [0.0, 0.0]),
        'voxel_size': cfg.get('voxel', 0.25),
        'gate': {'min_purity': GATE_PURITY, 'min_voxels': GATE_MIN_VOX},
        'deadband': DEADBAND,
        'class_names': CLASS_NAMES,
        'class_colors': CLASS_COLORS,
        'levels': {},
    }

    with h5py.File(H5, 'r') as f:
        print(f'reading {H5}')
        pos0 = f['level_0/pos'][:].astype(np.float32)
        rgb0 = f['level_0/rgb'][:].astype(np.uint8)
        elev0 = f['level_0/elevation'][:, 0].astype(np.float32)
        cc = f['level_0/Change_Code'][:].astype(np.float32)
        tr = f['level_0/is_transformed'][:].astype(np.float32)
        trans = f['level_0/Translation'][:].astype(np.float32)
        rot = f['level_0/Rotation'][:].astype(np.float32)
        stretch = f['level_0/Stretch'][:].astype(np.float32)
        distort = f['level_0/Distortion'][:].astype(np.float32)
        m3c2 = f['level_0/M3C2_distance'][:].astype(np.float32)
        sup01 = f['level_0/super_index'][:].astype(np.int64)      # P0 -> P1
        sup12 = f['level_1/super_index'][:].astype(np.int64)      # P1 -> P2
        sup23 = f['level_2/super_index'][:].astype(np.int64)      # P2 -> P3

        pos1 = f['level_1/pos'][:].astype(np.float32)
        pos2 = f['level_2/pos'][:].astype(np.float32)
        pos3 = f['level_3/pos'][:].astype(np.float32)
        ei1 = f['level_1/edge_index'][:].astype(np.int64)
        ei2 = f['level_2/edge_index'][:].astype(np.int64)
        ei3 = f['level_3/edge_index'][:].astype(np.int64)

    n0, n1, n2, n3 = len(pos0), len(pos1), len(pos2), len(pos3)
    print(f'levels: P0 {n0:,}  P1 {n1:,}  P2 {n2:,}  P3 {n3:,}')

    # ---- rebuilt label, majority + purity at every level -------------------
    label0 = rebuild_class(cc, tr)
    owner1 = sup01
    owner2 = sup12[sup01]
    owner3 = sup23[sup12[sup01]]
    maj1, pur1, nvox1 = majority_and_purity(owner1, label0, n1)
    maj2, pur2, nvox2 = majority_and_purity(owner2, label0, n2)
    maj3, pur3, nvox3 = majority_and_purity(owner3, label0, n3)

    kept1 = (pur1 >= GATE_PURITY) & (nvox1 >= GATE_MIN_VOX)
    manifest['gate']['p1_total'] = int(n1)
    manifest['gate']['p1_kept'] = int(kept1.sum())
    print(f'purity gate check: {int(kept1.sum()):,} / {n1:,} kept '
          f'({kept1.mean()*100:.1f} %)  -- Chapter 3/4 report 6,818 / 10,061 (67.8 %)')

    # ---- level 0: decimate, apply the SAME sample to every field -----------
    rng = np.random.default_rng(SEED)
    if n0 > LEVEL0_BUDGET:
        sel = np.sort(rng.choice(n0, LEVEL0_BUDGET, replace=False))
    else:
        sel = np.arange(n0)
    print(f'level 0: drawing {len(sel):,} of {n0:,} voxels '
          f'({len(sel)/n0*100:.1f} %)')

    lvl0 = {}
    lvl0.update(write_bin('level0_pos.bin', pos0[sel]))
    manifest['levels']['0'] = {'count': len(sel), 'fields': {}}
    L = manifest['levels']['0']['fields']
    L['pos'] = write_bin('level0_pos.bin', pos0[sel])
    L['rgb'] = write_bin('level0_rgb.bin', rgb0[sel])
    L['class'] = write_bin('level0_class.bin', label0[sel])
    L['elevation'] = write_bin('level0_elevation.bin', elev0[sel])
    L['m3c2'] = write_bin('level0_m3c2.bin', m3c2[sel])
    L['translation'] = write_bin('level0_translation.bin', trans[sel])
    L['rotation'] = write_bin('level0_rotation.bin', rot[sel])
    L['stretch'] = write_bin('level0_stretch.bin', stretch[sel])
    L['distortion'] = write_bin('level0_distortion.bin', distort[sel])
    L['parent1'] = write_bin('level0_parent1.bin', sup01[sel].astype(np.int32))

    # ---- levels 1-3: used in full ------------------------------------------
    for lvl, pos, maj, pur, nvox, kept, parent in (
            (1, pos1, maj1, pur1, nvox1, kept1, sup12.astype(np.int32)),
            (2, pos2, maj2, pur2, nvox2, None, sup23.astype(np.int32)),
            (3, pos3, maj3, pur3, nvox3, None, None)):
        manifest['levels'][str(lvl)] = {'count': len(pos), 'fields': {}}
        L = manifest['levels'][str(lvl)]['fields']
        L['pos'] = write_bin(f'level{lvl}_pos.bin', pos)
        L['class'] = write_bin(f'level{lvl}_class.bin', maj)
        L['purity'] = write_bin(f'level{lvl}_purity.bin', pur)
        L['n_voxels'] = write_bin(f'level{lvl}_nvox.bin', nvox)
        if kept is not None:
            L['kept'] = write_bin(f'level{lvl}_kept.bin', kept.astype(np.uint8))
        if parent is not None:
            L['parent'] = write_bin(f'level{lvl}_parent.bin', parent)

    # ---- edges: dedup by unordered pair, drop self-loops --------------------
    for lvl, ei, n in ((1, ei1, n1), (2, ei2, n2), (3, ei3, n3)):
        u, v = ei[0], ei[1]
        keep = u != v
        u, v = u[keep], v[keep]
        lo, hi = np.minimum(u, v), np.maximum(u, v)
        pairs = np.unique(np.stack([lo, hi], 1), axis=0).astype(np.int32)
        manifest['levels'][str(lvl)]['fields']['edges'] = \
            write_bin(f'level{lvl}_edges.bin', pairs)
        print(f'  P{lvl} edges: {len(pairs):,} undirected, '
              f'mean degree {2*len(pairs)/n:.2f}')

    manifest['generated_from'] = H5
    with open(os.path.join(OUT, 'manifest.json'), 'w', encoding='utf-8') as fh:
        json.dump(manifest, fh, indent=1)
    total = sum(os.path.getsize(os.path.join(OUT, fn)) for fn in os.listdir(OUT)
               if fn.endswith('.bin'))
    print(f'\nwrote {OUT}')
    print(f'total binary payload: {total/1024/1024:.1f} MB')


if __name__ == '__main__':
    sys.exit(main())
