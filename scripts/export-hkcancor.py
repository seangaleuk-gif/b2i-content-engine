#!/usr/bin/env python3
# Reproducible HKCanCor exporter via PyCantonese (pinned version).
#
# Usage: python scripts/export-hkcancor.py [output.json]
#
# Loads the HKCanCor corpus through pycantonese.hkcancor() and exports, as UTF-8
# JSON:
#   - all segmented word occurrences (count only, plus per-word frequency);
#   - unique Cantonese words;
#   - word frequencies;
#   - utterances;
#   - Jyutping;
#   - part-of-speech tags;
#   - source-file identifiers where available (file count + participant ids).
#
# The script fails loudly (non-zero exit) if the pinned PyCantonese version is not
# present or the corpus cannot be loaded. It never silently falls back.
import io
import json
import os
import sys
from collections import Counter

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

PINNED = "5.0.0"

try:
    import pycantonese
except Exception as exc:  # pragma: no cover - environment failure
    sys.stderr.write(f"pycantonese not importable: {exc}\n")
    sys.exit(2)

if pycantonese.__version__ != PINNED:
    sys.stderr.write(
        f"pycantonese version {pycantonese.__version__} != pinned {PINNED}; aborting\n"
    )
    sys.exit(3)

corpus = pycantonese.hkcancor()
tokens = corpus.tokens()

word_freq = Counter()
pos_of = {}
jyutping_of = {}
for tok in tokens:
    word = tok.word
    word_freq[word] += 1
    if word not in pos_of:
        pos_of[word] = tok.pos
    if word not in jyutping_of:
        jyutping_of[word] = tok.jyutping

utterances = []
for u in corpus.utterances():
    text = "".join(t.word for t in u.tokens)
    utterances.append({"participant": u.participant, "text": text})

out = {
    "version": PINNED,
    "source_file_identifiers": {
        "n_files": len(corpus.headers()),
        "participants": sorted(set(u["participant"] for u in utterances)),
    },
    "occurrence_count": int(sum(word_freq.values())),
    "unique_word_count": len(word_freq),
    "utterance_count": len(utterances),
    "word_frequency": dict(word_freq.most_common()),
    "pos": pos_of,
    "jyutping": jyutping_of,
    "utterances": utterances,
}

outpath = sys.argv[1] if len(sys.argv) > 1 else os.path.join(".tmp", "cantonese-raw", "hkcancor-export.json")
os.makedirs(os.path.dirname(os.path.abspath(outpath)), exist_ok=True)
with open(outpath, "w", encoding="utf-8") as fh:
    json.dump(out, fh, ensure_ascii=False)

print(
    f"exported occurrences={out['occurrence_count']} unique_words={out['unique_word_count']} "
    f"utterances={out['utterance_count']} files={out['source_file_identifiers']['n_files']}"
)
