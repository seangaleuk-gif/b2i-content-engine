# Cantonese Language Data — Attribution

This directory contains a local, deterministic Cantonese language resource for the
B2I Content Engine. All data is licensed for reuse. We store only openly licensed,
downloadable data and do **not** scrape full copyrighted dictionary definitions or
examples outside the published data licences.

## Sources

### 1. Words.hk word list

- **Project:** Words.hk 粵典 (Cantonese dictionary)
- **Source URL:** https://words.hk/
- **Repository:** https://github.com/words-hk/words.hk
- **Licence:** Public domain (the word list / headword and variant data).
- **Description:** Cantonese headwords, variants and Jyutping.
- **Downloaded:** 2026-08-04
- **Attribution:** Words.hk (https://words.hk/)

### 2. Words.hk English index

- **Project:** Words.hk 粵典 — English index
- **Source URL:** https://words.hk/
- **Licence:** Public domain.
- **Description:** Maps English definition terms to Cantonese dictionary headwords with
  relevance weighting. Only the headword-mapping index is used; full definition prose is
  not redistributed.
- **Downloaded:** 2026-08-04
- **Attribution:** Words.hk (https://words.hk/)

### 3. HKCanCor (Hong Kong Cantonese Corpus) through PyCantonese

- **Project:** HKCanCor (Hong Kong Cantonese Corpus) — distributed via PyCantonese
- **Source URL:** https://pycantonese.org/
- **Repository:** https://github.com/jacksonllee/hkcancor
- **Licence:** CC BY 4.0
- **Description:** ~153,000 segmented Cantonese word occurrences with part-of-speech
  annotations, Jyutping and natural spoken Cantonese utterances.
- **Downloaded:** 2026-08-04
- **Attribution:** Luke S. K. Wong, "Hong Kong Cantonese Corpus (HKCanCor)." Distributed
  under the CC BY 4.0 licence. https://pycantonese.org/

## Usage notes

- Only headwords, variants, Jyutping, part-of-speech tags, word frequencies and
  short example utterances are stored.
- Full dictionary definition prose and long copyrighted passages are **not** stored.
- `manifest.json` records the exact source URLs, licences, download dates,
  dataset checksums, versions and counts of each generated file.

## Seed fallback (unit tests only)

The committed `scripts/cantonese-seed.json` is used **only** by the unit-test-only
`--seed` import path, which is tagged `provenance: "seed-test"` and is never
presented as a successful corpus import. A **production** import never uses the
seed: it downloads and validates the real datasets, enforces minimum acceptance
counts, and **fails loudly** if any source cannot be loaded or any minimum is not
met — leaving any previous valid generated files untouched. A seed fallback is
never reported as a successful corpus import.
