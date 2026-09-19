# Performance

Measured with [`bench/`](../bench/README.md) on a throwaway Postgres
(`postgres:16-alpine`, tmpfs), ~14 KB mixed German/English transcript per
recording, `limit: 10`, p50 over 20 repetitions, importing the real built
`dist/` modules. Single-run measurements on one machine, not a statistical
benchmark — treat as orders of magnitude, not exact figures.

## Search latency, `scope: "all"`, 3 terms

| N      | v0.0.3     | v0.1.0 |
| ------ | ---------- | ------ |
| 1 000  | 1 679 ms   | 62 ms  |
| 5 000  | 8 386 ms   | 93 ms  |
| 20 000 | ~34 000 ms | 175 ms |

## v0.1.0 detail, p50

| N      | `scope: "summary"` | `scope: "all"` (two-stage) | `deep: true` |
| ------ | ------------------ | -------------------------- | ------------ |
| 1 000  | 4 ms               | 61 ms                      | 1 758 ms     |
| 5 000  | 24 ms              | 87 ms                      | 9 108 ms     |
| 20 000 | 96 ms              | 177 ms                     | 37 818 ms    |

## Cold metadata refresh

Recurs every `CACHE_TTL_MS`. Still O(N), dominated by decrypting
title/summary/key points/action items for every recording:

| N      | Cold refresh |
| ------ | ------------ |
| 1 000  | 345 ms       |
| 5 000  | 1 782 ms     |
| 20 000 | 5 948 ms     |

## Resident memory over baseline

| N      | v0.0.3 | v0.1.0 |
| ------ | ------ | ------ |
| 1 000  | 101 MB | 66 MB  |
| 5 000  | 340 MB | 211 MB |
| 20 000 | —      | 728 MB |

Roughly 37 KB per recording in v0.1.0, against ~61 KB in v0.0.3. Removing
transcript text from the cache accounts for the difference; what remains is
the cheap fields (title, summary, key points, action items), held both raw
and pre-normalized for search, plus per-object overhead.

## Flat, not corpus-dependent

`riffado_get_recording`'s transcript fetch: ~1.3 ms cold, ~0.001 ms warm
(LRU hit). `sliceText`: sub-millisecond. Neither scales with N.

## History of the two fixes

**v0.0.3** removed a per-term re-normalization: each field's text was
normalized once per search term, making latency linear in term count. At
N=1000: 1 499 / 3 033 / 4 513 / 7 513 ms for 1/2/3/5 terms.

**v0.1.0** removed the full-corpus transcript scan by making search
two-stage (cheap-field ranking, then transcript scan of only the top
candidates) and loading transcript text on demand instead of caching it for
the whole corpus. See [`architecture.md`](./architecture.md) for the design.

## Limitations

- **Cold refresh is O(N)** and repeats every `CACHE_TTL_MS`, even though
  search latency itself is now driven by the candidate set, not the corpus.
  At large N, raise `CACHE_TTL_MS`. An incremental refresh keyed on
  `updated_at` is the untaken next step.
- **Memory grows linearly with the number of recordings** (~37 KB each)
  because metadata and summaries stay cached — ~728 MB at 20 000 recordings.
- **Two-stage search narrows recall by design.** A term appearing only in a
  transcript, and in no title/summary/key point/action item, is not found
  by default. `deep: true` scans every date-filtered recording instead, at
  roughly the pre-v0.1.0 cost (~35 s at N=20 000), and is best combined with
  `from`/`to`.
- **No SQL-side search is possible at all**: the database holds only
  ciphertext, so there is nothing to index. An inverted index was
  considered and rejected — it matches whole tokens (at best prefixes),
  whereas the current substring scan finds `Wärmepumpe` for `wärme`, which
  German compounds depend on. See
  [`architecture.md`](./architecture.md#why-not-an-inverted-index).
