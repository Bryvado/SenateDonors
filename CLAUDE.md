# SenateDonors

Static, no-build Leaflet map of itemized individual contributions to the principal campaign committees of James Talarico, John Cornyn, and Ken Paxton (2026 Texas Senate), aggregated by reported state + 5-digit ZIP and drawn on 2020 Census ZCTAs, with estimated county, congressional district, CBSA, and county subdivision levels apportioned from the HUD ZIP crosswalks. Published to GitHub Pages at https://bryvado.github.io/SenateDonors/. A GitHub Action refreshes the FEC data every six hours.

Snapshot documented from commit `6a72736` (single commit, "Add files via upload"; no prior history).

## Working copy (repo is ~94 MB, almost all geometry)

Most of the weight is `data/zctas/*.bin` (~85 MB) and `data/levels/geo/cousub/*.bin` (~20 MB). For code work, use a sparse, blobless clone that keeps Texas geometry only:

```
git clone --filter=blob:none --sparse https://github.com/Bryvado/SenateDonors.git
cd SenateDonors
git sparse-checkout set --no-cone '/*' '!/data/zctas/' '!/data/levels/geo/cousub/' '/data/zctas/TX.bin' '/data/levels/geo/cousub/TX.bin'
```

Add more states with extra `'/data/zctas/XX.bin'` and `'/data/levels/geo/cousub/XX.bin'` patterns. Keep `data/crosswalks/` checked out if you run `update_data.py`. Opening a state (at the ZIP or county subdivision level) whose `.bin` is not checked out will show the app's error panel locally; that is expected, not a bug. Never delete or rewrite the unchecked-out `.bin` files in a commit.

Local preview: `python3 -m http.server 8000` from the repo root (not `file://`; the app uses `fetch`).

## Layout

```
index.html            UI shell: masthead selects (period, two candidates, color measure), map buttons, legend, footer, About panel
app.js                All client logic (~11 KB, vanilla JS + Leaflet global `L`)
style.css             All styling; responsive breakpoints at 850px and 540px
vendor/               Leaflet 1.9.4 (js, css, license), vendored, no CDN
scripts/
  update_data.py      FEC refresh + reconciliation + level allocation; writes all tracked data outputs. `--levels-only` regenerates data/levels/*.csv from the current receipts.csv
  seed.py             One-time rebuild of aggregates from an external audited bundle; imports publish() from update_data.py
  convert_crosswalks.py  Stdlib xlsx -> CSV converter for the HUD crosswalk workbooks
  build_geometry.py   Rebuilds states.json, zctas/*.bin and levels/geo/* from Census archives (geopandas); every input flag is optional
data/
  receipts.csv        state,zip,candidate,phase,positive_cents,net_cents,count   (~24.6k rows, CRLF)
  state_totals.csv    state,candidate,phase,positive_cents,net_cents,count       (~410 rows, includes unmappable ZIPs)
  coverage.json       retrieved date, coverage_start/end, filing_count, source strings
  filings.json        {committees: {id: [file_numbers]}, reports: [...]}; the committees map is the change-detection signature
  states.json         Simplified state polygons, properties {code, name}
  zctas/XX.bin        Gzipped GeoJSON FeatureCollection per state/territory, properties {zip}
  crosswalks/         HUD USPS ZIP crosswalks (06/2026) as CSV: zip,geoid,state,res_ratio,tot_ratio. ZIP-COUNTY, ZIP-CD, ZIP-CBSA, ZIP-COUNTY-SUB are used; ZIP-CBSA-DIVISION is converted but unused
  levels/{county,cd,cbsa,cousub}.csv   geoid,candidate,phase,positive_cents,net_cents,count (count has 2 decimals, estimated)
  levels/unallocated.csv               level,state,candidate,phase,... dollars in placeholder geoids, by reported state
  levels/geo/{county,cd,cbsa}.bin      Gzipped GeoJSON, national, properties {geoid, name, states:[USPS codes touched]}
  levels/geo/cousub/XX.bin             Gzipped GeoJSON per state, properties {geoid, name}
.github/workflows/site.yml   Refresh + Pages deploy
```

## Data pipeline (`scripts/update_data.py`)

1. `inventory()`: OpenFEC `/v1/reports/house-senate/` per committee, cycle 2026, keeps `most_recent`, e-filed reports with a `csv_url` and coverage ending on or after 2025-01-01. `FEC_API_KEY` env var, else `DEMO_KEY`.
2. If the sorted file-number signature equals `filings.json["committees"]`, exit with no changes.
3. `parse_report()`: streams each FEC CSV (host must be `docquery.fec.gov`) to a temp file, keeps `SA11AI` rows, drops memo rows (col 42 == `X`). Every non-memo SA11AI amount counts toward the reconciliation total; only entity `IND` rows are aggregated. Raises if the sum differs from `individual_itemized_contributions_period` or if a transaction ID repeats within a committee.
4. Column indices used: 1 committee, 2 transaction ID, 5 entity type, 15 state, 16 ZIP, 19 date (YYYYMMDD), 20 amount, 42 memo code.
5. Aggregates in integer cents into `[positive_cents, net_cents, count]`, where count = positive entries (not unique donors). Negative receipts affect `net_cents` only; Schedule B refunds are not subtracted.
6. `publish()` writes all outputs to a temp dir, runs `allocate_levels()` on the staged `receipts.csv`, then `os.replace`s everything into `data/`, so a failure leaves tracked data untouched. `seed.py` goes through the same function.

### Level allocation (`allocate_levels`)

- Crosswalk matched on ZIP alone (the reported state is not checked against the crosswalk's state). ZIPs not in a crosswalk are left out of that level, like unmatched ZCTAs.
- Weight = `res_ratio`; if a ZIP's res_ratios sum to 0 (PO box/business-only), `tot_ratio`. Weights are normalized per ZIP.
- Each receipts row's `positive_cents`, `net_cents`, and count (in hundredths) is split by weight with rounding, and the remainder goes to the largest share, so each ZIP's totals are preserved exactly.
- Geoids that are not mappable go to `unallocated.csv` under the donor's reported state: any containing `*`, CBSA `99999` (non-metro), and malformed codes (e.g. county `48`, `64` for freely associated states). The `LEVELS` regex in `update_data.py` defines this.
- Raises unless, per level, mapped + unallocated positive_cents equals the crosswalk-matched ZIP total to the cent.
- New HUD quarter: drop the xlsx files in `data/crosswalks/`, run `scripts/convert_crosswalks.py data/crosswalks/*.xlsx`, delete the xlsx, then `python3 scripts/update_data.py --levels-only`. Recheck the geometry vintages below.

### Level geometry vintages

- County: `cb_2024_us_county_500k` (has Connecticut planning regions, matching HUD). CBSA: `cb_2024_us_cbsa_500k`. County subdivision: `cb_2022_us_cousub_500k`; 2022 matches the HUD geoids best (2024 lacks ~1,200 Arkansas geoids HUD still uses).
- Congressional districts: **119th Congress** (`cb_2024_us_cd119_500k`). Checked 2026-09: for Texas, ZCTA representative points fell in the crosswalk's highest-weight district 89.7% of the time for the 119th file vs 67.5% for PLANC2333 (2025 mid-decade plan); for single-district ZIPs 98.9% vs 76.6%. Census at-large/delegate code `98` is rewritten to HUD's `00`. Recorded in `coverage.json` as `cd_vintage` and stated in the About panel. Recheck when HUD moves to a newer map.

Phases (`phase_for`): `pre_primary` through 2026-03-03, `between_primary_runoff` through 2026-05-26, `post_runoff` after. Receipts before 2025-01-01 are dropped.

## Front end (`app.js`)

Global `state` object holds UI selections plus Maps: `receipts` keyed `STATE|ZIP|COMMITTEE`, `totals` keyed `STATE|COMMITTEE`, each value `{phase: [dollars, net_dollars, count]}` (cents divided by 100 on load). Period `all` sums the three phases at read time.

Startup loads `states.json`, both CSVs, and `coverage.json`, draws states, then opens TX. `openState(code)` fetches `data/zctas/CODE.bin`, decompresses via `DecompressionStream('gzip')`, and adds a GeoJSON layer; `closeState` removes it. Single click vs double click is disambiguated with a 230 ms timeout.

Coloring (`color()`): "lead"/Dominance blends red (#ac3546) to neutral to blue (#246a93) by the first candidate's share of positive dollars, with opacity scaled by log total; "volume" uses a log ramp from `levels[level].range` (log10 dollars: ZCTA and cousub $0–$100k, county and CBSA $100–$1m, CD $3k–$3m; states $10k–$10m). Gray = no receipts. Shading always uses `positive_cents`.

Levels: `levels` object in `app.js` and the `#level` select. `state.level` picks the layer drawn when a state is opened; switching level closes and reopens the open states. Non-ZIP data loads lazily into `state.areas[level]` keyed `GEOID|COMMITTEE`, and `levels/unallocated.csv` into `state.unallocated` keyed `LEVEL|STATE|COMMITTEE` (shown in the state tooltip). County/CD/CBSA geometry loads once nationally and is filtered by the feature's `states` list, so a multi-state CBSA appears under each open state; cousub loads per state. Non-ZIP tooltips say "estimated entries".

The CSV parser is a plain comma split. That works only because no field is quoted; keep outputs quote-free or replace the parser.

## Things that must stay in sync

- Candidate committee IDs and names: `CANDIDATES` in `update_data.py`, `names` in `app.js`, and both `<select>` lists in `index.html`. Adding a candidate touches all three plus the legend logic, which assumes exactly two compared.
- Phase keys and date cutoffs: `PHASES`/`phase_for` in Python, `phases` in `app.js`, option labels in `index.html` ("Through Mar 3", "Mar 4 – May 26", "Since May 27").
- Cache-busting query strings: `app.js?v=6` in `index.html`, `states.json?v=2`, `zctas/*.bin?v=3` and `levels/geo/*.bin?v=1` in `app.js`. Bump when those files change.
- The Pages artifact is built by copying `index.html style.css app.js data vendor` only. New top-level assets must be added to the "Prepare static site" step. (This CLAUDE.md is therefore not published.)
- The workflow's commit step `git add`s the four data outputs plus `data/levels/*.csv`. A new generated file needs to be added there too.
- Level keys (`county`, `cd`, `cbsa`, `cousub`): `LEVELS` in `update_data.py`, `levels` in `app.js`, the `#level` select, and the file names in `build_geometry.py`.

## Geography caveats (relevant to correctness work)

- ZIP-to-ZCTA matching (ZIP level) is by identical 5-digit string; there is no crosswalk step. Other levels use the HUD crosswalks. ZIPs with no same-numbered ZCTA (PO boxes, unique ZIPs) appear only in `state_totals.csv`.
- Each ZCTA lives in exactly one state file, assigned by representative point (nearest state as fallback). Receipts are keyed by the donor's reported state, so a ZIP reported in one state whose ZCTA was assigned to a neighboring state's file will not shade.
- Non-state codes (AE, AP, AA, etc.) exist in the CSVs but have no geometry.

## Workflow (`site.yml`)

Triggers: push to `main`, cron `17 */6 * * *`, manual dispatch. On non-push runs it executes `update_data.py` and commits changed data as `senate-donors-bot`; every run then builds `_site/` and deploys via `actions/deploy-pages@v4`. Needs Pages source set to GitHub Actions; optional secret `FEC_API_KEY`.

## Conventions

- No build step, no npm, no framework. Keep it that way unless asked.
- Python scripts use only the standard library, except `build_geometry.py` (geopandas, pyogrio, shapely).
- Never commit individual donor names, addresses, or row-level FEC records; only aggregates.
- Money stays in integer cents in data files.
