# SenateDonors

Static, no-build Leaflet map of itemized individual contributions to the principal campaign committees of James Talarico, John Cornyn, and Ken Paxton (2026 Texas Senate), aggregated by reported state + 5-digit ZIP and drawn on 2020 Census ZCTAs. Published to GitHub Pages at https://bryvado.github.io/SenateDonors/. A GitHub Action refreshes the FEC data every six hours.

Snapshot documented from commit `6a72736` (single commit, "Add files via upload"; no prior history).

## Working copy (repo is ~94 MB, almost all geometry)

Most of the weight is `data/zctas/*.bin` (~85 MB) and `data/crosswalks/*.xlsx` (~13 MB). For code work, use a sparse, blobless clone that keeps Texas geometry only (~13 MB on disk):

```
git clone --filter=blob:none --sparse https://github.com/Bryvado/SenateDonors.git
cd SenateDonors
git sparse-checkout set --no-cone '/*' '!/data/zctas/' '!/data/crosswalks/' '/data/zctas/TX.bin'
```

Add more states with extra `'/data/zctas/XX.bin'` patterns. Opening a state whose `.bin` is not checked out will show the app's error panel locally; that is expected, not a bug. Never delete or rewrite the unchecked-out `.bin` files in a commit.

Local preview: `python3 -m http.server 8000` from the repo root (not `file://`; the app uses `fetch`).

## Layout

```
index.html            UI shell: masthead selects (period, two candidates, color measure), map buttons, legend, footer, About panel
app.js                All client logic (~11 KB, vanilla JS + Leaflet global `L`)
style.css             All styling; responsive breakpoints at 850px and 540px
vendor/               Leaflet 1.9.4 (js, css, license), vendored, no CDN
scripts/
  update_data.py      FEC refresh + reconciliation; writes the four tracked data outputs
  seed.py             One-time rebuild of aggregates from an external audited bundle; imports from update_data.py
  build_geometry.py   Rebuilds states.json and zctas/*.bin from Census TIGER archives (geopandas)
data/
  receipts.csv        state,zip,candidate,phase,positive_cents,net_cents,count   (~24.6k rows, CRLF)
  state_totals.csv    state,candidate,phase,positive_cents,net_cents,count       (~410 rows, includes unmappable ZIPs)
  coverage.json       retrieved date, coverage_start/end, filing_count, source strings
  filings.json        {committees: {id: [file_numbers]}, reports: [...]}; the committees map is the change-detection signature
  states.json         Simplified state polygons, properties {code, name}
  zctas/XX.bin        Gzipped GeoJSON FeatureCollection per state/territory, properties {zip}
  crosswalks/         HUD USPS ZIP crosswalks (ZIP-CD, ZIP-COUNTY, ZIP-CBSA, etc., 06/2026) + 1-byte txt.txt placeholder. Not referenced by any code.
.github/workflows/site.yml   Refresh + Pages deploy
```

## Data pipeline (`scripts/update_data.py`)

1. `inventory()`: OpenFEC `/v1/reports/house-senate/` per committee, cycle 2026, keeps `most_recent`, e-filed reports with a `csv_url` and coverage ending on or after 2025-01-01. `FEC_API_KEY` env var, else `DEMO_KEY`.
2. If the sorted file-number signature equals `filings.json["committees"]`, exit with no changes.
3. `parse_report()`: streams each FEC CSV (host must be `docquery.fec.gov`) to a temp file, keeps `SA11AI` rows, drops memo rows (col 42 == `X`). Every non-memo SA11AI amount counts toward the reconciliation total; only entity `IND` rows are aggregated. Raises if the sum differs from `individual_itemized_contributions_period` or if a transaction ID repeats within a committee.
4. Column indices used: 1 committee, 2 transaction ID, 5 entity type, 15 state, 16 ZIP, 19 date (YYYYMMDD), 20 amount, 42 memo code.
5. Aggregates in integer cents into `[positive_cents, net_cents, count]`, where count = positive entries (not unique donors). Negative receipts affect `net_cents` only; Schedule B refunds are not subtracted.
6. Writes all outputs to a temp dir, then `os.replace` into `data/`, so a failure leaves tracked data untouched.

Phases (`phase_for`): `pre_primary` through 2026-03-03, `between_primary_runoff` through 2026-05-26, `post_runoff` after. Receipts before 2025-01-01 are dropped.

## Front end (`app.js`)

Global `state` object holds UI selections plus Maps: `receipts` keyed `STATE|ZIP|COMMITTEE`, `totals` keyed `STATE|COMMITTEE`, each value `{phase: [dollars, net_dollars, count]}` (cents divided by 100 on load). Period `all` sums the three phases at read time.

Startup loads `states.json`, both CSVs, and `coverage.json`, draws states, then opens TX. `openState(code)` fetches `data/zctas/CODE.bin`, decompresses via `DecompressionStream('gzip')`, and adds a GeoJSON layer; `closeState` removes it. Single click vs double click is disambiguated with a 230 ms timeout.

Coloring (`color()`): "lead"/Dominance blends red (#ac3546) to neutral to blue (#246a93) by the first candidate's share of positive dollars, with opacity scaled by log total; "volume" uses a log ramp (ZCTA scale $0 to $100k, state scale $10k to $10m). Gray = no receipts. Shading always uses `positive_cents`.

The CSV parser is a plain comma split. That works only because no field is quoted; keep outputs quote-free or replace the parser.

## Things that must stay in sync

- Candidate committee IDs and names: `CANDIDATES` in `update_data.py`, `names` in `app.js`, and both `<select>` lists in `index.html`. Adding a candidate touches all three plus the legend logic, which assumes exactly two compared.
- Phase keys and date cutoffs: `PHASES`/`phase_for` in Python, `phases` in `app.js`, option labels in `index.html` ("Through Mar 3", "Mar 4 – May 26", "Since May 27").
- Cache-busting query strings: `app.js?v=5` in `index.html`, `states.json?v=2` and `zctas/*.bin?v=3` in `app.js`. Bump when those files change.
- The Pages artifact is built by copying `index.html style.css app.js data vendor` only. New top-level assets must be added to the "Prepare static site" step. (This CLAUDE.md is therefore not published.)
- The workflow's commit step `git add`s exactly the four data outputs. A new generated file needs to be added there too.

## Geography caveats (relevant to correctness work)

- ZIP-to-ZCTA matching is by identical 5-digit string; there is no crosswalk step. ZIPs with no same-numbered ZCTA (PO boxes, unique ZIPs) appear only in `state_totals.csv`.
- Each ZCTA lives in exactly one state file, assigned by representative point (nearest state as fallback). Receipts are keyed by the donor's reported state, so a ZIP reported in one state whose ZCTA was assigned to a neighboring state's file will not shade.
- Non-state codes (AE, AP, AA, etc.) exist in the CSVs but have no geometry.

## Workflow (`site.yml`)

Triggers: push to `main`, cron `17 */6 * * *`, manual dispatch. On non-push runs it executes `update_data.py` and commits changed data as `senate-donors-bot`; every run then builds `_site/` and deploys via `actions/deploy-pages@v4`. Needs Pages source set to GitHub Actions; optional secret `FEC_API_KEY`.

## Conventions

- No build step, no npm, no framework. Keep it that way unless asked.
- Python scripts use only the standard library, except `build_geometry.py` (geopandas, pyogrio, shapely).
- Never commit individual donor names, addresses, or row-level FEC records; only aggregates.
- Money stays in integer cents in data files.
