# -*- coding: utf-8 -*-
"""Add the classifier's out-of-sample result to the P1 export.

The viewer's Class colouring is the REFERENCE label: the majority of each unit's
rebuilt voxel labels. This script adds the model's answer beside it, for every
P1 unit the class the selected configuration (all features plus the P2 parent
block) predicted while the spatial fold holding that unit was left out of
training. It reads cv_predictions.csv, the file the thesis's prediction maps,
pooled confusion matrix and QGIS layers are all made from.

Writes data/level1_pred.bin (uint8, one byte per P1 unit, 255 where the purity
gate discarded the unit and it was never predicted) and adds a `prediction`
block to manifest.json holding the scores the file reproduces.

Nothing is written unless the file lines up with the export exactly: the same
6,818 units the gate keeps, and for each the same reference class and voxel
count. A prediction file from another partition would otherwise paint
plausible colours on the wrong units, and nothing on screen would say so.

export_nag.py rewrites manifest.json without this block, so run this after it
(and after Python/Claude/river_extent_purity.py, which adds the overlays):

    python tools/export_predictions.py
    python tools/export_predictions.py --csv PATH/cv_predictions.csv
    python tools/check_package.py --write

numpy only.
"""
import csv
import io
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(os.path.dirname(HERE), 'data')
REL = os.path.join('SPT_anthony', 'superpoint_transformer-master', 'data', 'isar',
                   'cv_predictions.csv')
NOT_EVALUATED = 255
MODEL = 'All features + P2 parent block, the selected configuration'
SCHEME = ('three spatial folds; each unit predicted by the model trained '
          'without the fold that holds it')


def default_csv():
    """The thesis tree keeps the file beside the partition. Look upwards for it
    rather than hardcoding a depth: this folder has moved within that tree once."""
    d = HERE
    while True:
        p = os.path.join(d, REL)
        if os.path.exists(p):
            return p
        up = os.path.dirname(d)
        if up == d:
            return None
        d = up


def main():
    src = sys.argv[sys.argv.index('--csv') + 1] if '--csv' in sys.argv else default_csv()
    if not src or not os.path.exists(src):
        sys.exit('cv_predictions.csv not found; pass --csv PATH/cv_predictions.csv')

    man_path = os.path.join(DATA, 'manifest.json')
    manifest = json.load(io.open(man_path, encoding='utf-8'))
    L1 = manifest['levels']['1']
    n1 = L1['count']

    def field(name, dtype):
        return np.fromfile(os.path.join(DATA, L1['fields'][name]['file']), dtype)

    ref = field('class', np.uint8)
    kept = field('kept', np.uint8).astype(bool)
    nvox = field('n_voxels', np.int32)

    with io.open(src, encoding='utf-8-sig', newline='') as fh:
        rows = list(csv.DictReader(fh))
    sid = np.array([int(r['superpoint_id']) for r in rows])
    true = np.array([int(r['true']) for r in rows])
    pred = np.array([int(r['pred']) for r in rows])
    nv = np.array([int(r['n_voxels']) for r in rows])

    problems = []
    if len(np.unique(sid)) != len(sid):
        problems.append('duplicate superpoint ids')
    if sid.min() < 0 or sid.max() >= n1:
        problems.append('ids outside 0..%d' % (n1 - 1))
    elif set(sid.tolist()) != set(np.flatnonzero(kept).tolist()):
        problems.append('the predicted units are not the %d units the gate keeps'
                        % kept.sum())
    else:
        if (ref[sid] != true).any():
            problems.append('%d reference classes differ from the export'
                            % (ref[sid] != true).sum())
        if (nvox[sid] != nv).any():
            problems.append('%d voxel counts differ from the export'
                            % (nvox[sid] != nv).sum())
    if ((pred < 0) | (pred > 4)).any():
        problems.append('a predicted class outside 0..4')
    if problems:
        sys.exit('REFUSING to write predictions: ' + '; '.join(problems))

    out = np.full(n1, NOT_EVALUATED, np.uint8)
    out[sid] = pred
    name = 'level1_pred.bin'
    out.tofile(os.path.join(DATA, name))

    cm = np.zeros((5, 5), np.int64)
    np.add.at(cm, (true, pred), 1)
    tp = np.diag(cm)
    fp, fn = cm.sum(0) - tp, cm.sum(1) - tp
    f1 = 2 * tp / np.maximum(2 * tp + fp + fn, 1)
    iou = tp / np.maximum(tp + fp + fn, 1)

    L1['fields']['pred'] = {'file': name, 'dtype': 'uint8', 'shape': [int(n1)],
                            'bytes': int(out.nbytes)}
    manifest['prediction'] = {
        'source': os.path.basename(src),
        'model': MODEL,
        'scheme': SCHEME,
        'level': '1',
        'field': 'pred',
        'not_evaluated': NOT_EVALUATED,
        'evaluated': int(len(sid)),
        'correct': int(tp.sum()),
        'accuracy': round(float(tp.sum()) / len(sid), 6),
        'macro_f1': round(float(f1.mean()), 6),
        'mean_iou': round(float(iou.mean()), 6),
    }
    io.open(man_path, 'w', encoding='utf-8').write(
        json.dumps(manifest, ensure_ascii=False, indent=1))

    p = manifest['prediction']
    print('checked against the export: %s units, ids, reference class and voxel '
          'count all agree' % format(p['evaluated'], ','))
    print('wrote %s (%d units, %d not evaluated)'
          % (name, n1, int((out == NOT_EVALUATED).sum())))
    print('out of sample: accuracy %.3f (%s / %s), macro-F1 %.3f, mean IoU %.5f'
          % (p['accuracy'], format(p['correct'], ','), format(p['evaluated'], ','),
             p['macro_f1'], p['mean_iou']))
    print('-- the thesis reports accuracy 0.791 and macro-F1 0.704; if these differ, '
          'the prediction file is not the one the thesis used')


if __name__ == '__main__':
    main()
