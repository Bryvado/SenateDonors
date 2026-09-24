# Senate donors

Full-screen map of individual, itemized contributions to the principal federal campaign committees of James Talarico, John Cornyn, and Ken Paxton. [Open the map](https://bryvado.github.io/SenateDonors/).

The map opens on Texas. Click another state to load its 2020 Census ZCTAs, double-click it or its ZCTAs to hide the detail, or use **US** to zoom out. Select a period, two candidates, and whether color shows the candidate leading in positive dollars or combined positive dollars. Click a ZCTA to zoom in. The USGS basemap can be switched off. The entire interface fits the viewport.

## Data

`data/receipts.csv` has public aggregates by reported state, five-digit mailing ZIP, candidate committee, and one of three mutually exclusive periods. `data/state_totals.csv` includes reported ZIPs that cannot be mapped. Dollar values are stored in integer cents; `net_cents` includes negative receipt adjustments but does not subtract Schedule B refunds. Shading uses `positive_cents`. Counts are positive line entries, not distinct donors.

The geometry is the Census 2020 cartographic boundary ZCTA 500k series, simplified and gzip packed per state for the web. A ZIP is a delivery route, while a ZCTA is an approximation of a geographic area. Some reported ZIPs have no polygon. No individual donor details or street addresses are published. The map excludes unitemized receipts, joint fundraising committee allocations, independent spending, PAC receipts and other committees. Cross-state ZCTAs are assigned once, by their representative point. These boundaries are not precincts.

The seed aggregates came from 20 audited FEC electronic filings through June 30, 2026. `scripts/update_data.py` checks each candidate's 2026 Form 3 reports via OpenFEC, selects `most_recent` electronic filings, streams official CSV filings, drops memo entries, restricts to individual line 11(a)(i), verifies each report against the FEC itemized total, and writes only aggregated data. If any report fails reconciliation, the action fails without committing new data. Filing changes are checked every six hours by GitHub Actions. Set a repository secret named `FEC_API_KEY` for a higher API rate limit; the script uses the FEC's public `DEMO_KEY` otherwise. Refresh may lag the FEC's publication schedule, and the coverage date is shown on the map.

## Development

Run `python3 -m http.server 8000` at the repository root, then visit `http://localhost:8000`. Browser `file://` URLs cannot load the local GeoJSON using `fetch`.

The static app has no build step and includes a local copy of Leaflet 1.9.4 (BSD-2-Clause). It requests public [USGS Topo tiles](https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer) without an API key. It also works without the basemap if those tiles are unavailable.

Rebuild geometry from the two 2020 [Census cartographic archives](https://www.census.gov/geographies/mapping-files/time-series/geo/cartographic-boundary.html) using `python3 -m pip install geopandas pyogrio shapely` and `python3 scripts/build_geometry.py --zctas zctas.zip --states states.zip --out data`. The downloaded shapefile archives are not committed. To recreate the original seeded aggregates from the separately audited source bundle, run `python3 scripts/seed.py /path/to/tx_senate_fec_zip_data`.

The workflow stages the static files, and data refreshes have their own commits. To publish, enable GitHub Pages with **GitHub Actions** as the source in repository Settings → Pages. The workflow deploys on pushes and after scheduled refreshes.
