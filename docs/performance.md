# Performance

Measured with [`bench/`](../bench/README.md) on a throwaway Postgres
(`postgres:16-alpine`, tmpfs), ~14 KB mixed German/English transcript per
recording, `limit: 10`, p50 over 20 repetitions, importing the real built
`dist/` modules. Single-run measurements on one machine, not a statistical
benchmark — treat as orders of magnitude, not exact figures.

## Search latency, 3 terms, `limit: 10`

| N      | `scope: "summary"` | `scope: "all"` (two-stage) | `deep: true` |
| ------ | ------------------ | -------------------------- | ------------ |
| 1 000  | 4 ms               | 62 ms                      | 1 758 ms     |
| 5 000  | 24 ms              | 93 ms                      | 9 108 ms     |
| 20 000 | 96 ms              | 175 ms                     | 37 818 ms    |

`scope: "summary"` never fetches a transcript. `scope: "all"` runs the
two-stage design (see [`architecture.md`](./architecture.md#riffado_search-is-two-stage)):
stage 1 ranks the whole corpus over cheap fields only, stage 2 fetches
transcripts for the top candidates. `deep: true` scans every date-filtered
recording's transcript instead of just the candidates, and its cost scales
with corpus size — combine it with `from`/`to`.

## Refresh: cold / unchanged / a few changes

`RecordingStore.refresh()` is two-phase (see
[`architecture.md`](./architecture.md#incremental-refresh-two-phases-the-iv-as-the-change-signal)):
phase 1 cheaply stamps every recording, phase 2 rebuilds only what changed.
Total ms, with the sql/decrypt-and-build split in parentheses where captured:

| N      | cold             | unchanged    | 10 recordings changed |
| ------ | ---------------- | ------------ | --------------------- |
| 1 000  | 419 (118/302)    | 25 (22/3)    | 28 (2/26)             |
| 5 000  | 1 738 (608/1131) | 123 (108/15) | 117 (3/114)           |
| 20 000 | 7 145            | 509          | 478                   |

(sql/decrypt split not captured at N=20 000.)

**An unchanged refresh is still O(N), not constant-time** — phase 1's stamp
query touches every row even when nothing rebuilds. It's roughly 14-17x
cheaper per row than a cold refresh (e.g. at N=5 000: ~0.35 ms/row cold vs.
~0.025 ms/row unchanged), not free. At large N, raise `CACHE_TTL_MS` rather
than expect refresh to disappear.

## Memory

~37 KB per recording; resident memory over baseline: ~65 MB at N=1 000,
~207 MB at N=5 000, ~738 MB at N=20 000. Held: title, summary, key points,
action items, both raw and pre-normalized for search, plus per-object
overhead — transcript text is never cached for the whole corpus, only
fetched on demand into a small LRU.

Per-unchanged-refresh RSS delta at N=5 000 is ~1.78 MB — reused recordings
are carried forward by reference, not copied, so this reflects allocator
retention rather than a leak.

## Flat, not corpus-dependent

`riffado_get_recording`'s transcript fetch: ~1.3 ms cold, ~0.001 ms warm
(LRU hit). `sliceText`: sub-millisecond. Neither scales with N.

## Limitations

- **Refresh is O(N) even when nothing changed** — see the refresh section
  above for the numbers and the mitigation.
- **Memory grows linearly with the number of recordings** (~37 KB each)
  because metadata and summaries stay cached — ~738 MB at 20 000
  recordings.
- **Two-stage search narrows recall by design.** A term appearing only in
  a transcript, and in no title/summary/key point/action item, is not
  found by default. `deep: true` scans every date-filtered recording
  instead, at roughly its own O(N) cost, and is best combined with
  `from`/`to`.
- **No SQL-side search is possible at all**: the database holds only
  ciphertext, so there is nothing to index. An inverted index was
  considered and rejected — it matches whole tokens (at best prefixes),
  whereas the current substring scan finds `Wärmepumpe` for `wärme`, which
  German compounds depend on. See
  [`architecture.md`](./architecture.md#why-not-an-inverted-index).
- **The incremental-refresh IV stamp only covers the `v1:`/wrapped-jsonb
  shape.** A field written in any other shape can't be cheaply verified
  unchanged from a prefix alone, so it's always routed through phase 2 and
  rebuilt — correct, just not free. On the current production database
  every stamped column is fully wrapped, so this doesn't apply to any
  recording today; it's a fallback for whatever shape a future migration
  or import path might produce.
