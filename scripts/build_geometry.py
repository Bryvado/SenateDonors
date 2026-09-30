"""Create the map's boundary files from Census archives.

Run only when the Census boundaries need updating. Each input is optional, so
one layer can be rebuilt at a time. Input archives:
  --zctas   https://www2.census.gov/geo/tiger/TIGER2020/ZCTA520/tl_2020_us_zcta520.zip
  --states  https://www2.census.gov/geo/tiger/GENZ2020/shp/cb_2020_us_state_500k.zip
  --county  https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_us_county_500k.zip
  --cd      https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_us_cd119_500k.zip
  --cbsa    https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_us_cbsa_500k.zip
  --cousub  https://www2.census.gov/geo/tiger/GENZ2022/shp/cb_2022_us_cousub_500k.zip

--zctas needs --states (ZCTAs are filed by the state holding their representative
point). The level files are written to OUT/levels/geo/ with properties {geoid, name}
(plus the USPS codes touched, `states`, on the national files); geoids match the HUD
crosswalk CSVs. The 2022 county subdivision vintage is used because it matches the
HUD 06/2026 crosswalk best (2024 drops about 1,200 Arkansas geoids the crosswalk
still uses). The HUD CD crosswalk uses 119th Congress districts (checked against
Texas PLANC2333, the 2025 mid-decade plan, which agreed far less); see CLAUDE.md.

Geometry is sized for the map's maxZoom of 12 (about 33 m per pixel in Texas):
- each layer is simplified as a coverage (shapely.coverage_simplify), so neighbours
  keep one shared edge and no slivers or gaps open between them; tolerances are in
  meters, in an equal-area projection for each region;
- .bin files are gzipped TopoJSON (decoded in the browser by vendor/topojson-client),
  quantized to 1e-4 degrees (about 11 m), with one object per file;
- states.json stays plain GeoJSON rounded to 4 decimals, since it is the first thing
  the page draws.
Afterwards run scripts/build_manifest.py so browsers pick up the new files.

Needs geopandas, pyogrio, shapely >= 2.1 and topojson (pip install topojson).
"""

import argparse
import gzip
import json
import math
from pathlib import Path

import geopandas as gpd
import shapely
import topojson
from shapely.geometry import mapping

# Coverage-simplification tolerances in meters, per layer. Checked with screenshots at
# zooms 6, 9 and 12 over Houston, Dallas-Fort Worth and Manhattan.
TOLERANCE = {"states": 2500, "zcta": 60, "county": 200, "cd": 200, "cbsa": 200, "cousub": 100}
QUANTUM = 1e-4  # degrees between quantized coordinates

FIPS = {"01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT", "10": "DE",
        "11": "DC", "12": "FL", "13": "GA", "15": "HI", "16": "ID", "17": "IL", "18": "IN", "19": "IA",
        "20": "KS", "21": "KY", "22": "LA", "23": "ME", "24": "MD", "25": "MA", "26": "MI", "27": "MN",
        "28": "MS", "29": "MO", "30": "MT", "31": "NE", "32": "NV", "33": "NH", "34": "NJ", "35": "NM",
        "36": "NY", "37": "NC", "38": "ND", "39": "OH", "40": "OK", "41": "OR", "42": "PA", "44": "RI",
        "45": "SC", "46": "SD", "47": "TN", "48": "TX", "49": "UT", "50": "VT", "51": "VA", "53": "WA",
        "54": "WV", "55": "WI", "56": "WY", "60": "AS", "66": "GU", "69": "MP", "72": "PR", "78": "VI"}


def region_crs(point):
    """Equal-area or UTM projection for the region around a lon/lat point. Regions never share edges."""
    x, y = point.x, point.y
    if y > 50:
        return "EPSG:3338"   # Alaska Albers
    if x < -150 and y > 15:
        return "EPSG:32604"  # Hawaii
    if x < -160 and y < 0:
        return "EPSG:32702"  # American Samoa
    if x > 140:
        return "EPSG:32655"  # Guam, Northern Mariana Islands
    if x > -68 and y < 20:
        return "EPSG:32620"  # Puerto Rico, U.S. Virgin Islands
    return "EPSG:5070"       # Conterminous U.S. Albers


def simplify(frame, tolerance):
    """Coverage-simplify a lon/lat frame region by region; returns lon/lat geometries in frame order."""
    frame = frame[~frame.geometry.is_empty & frame.geometry.notna()].copy()
    frame["geometry"] = shapely.make_valid(frame.geometry.values)
    frame["geometry"] = frame.geometry.apply(polygonal)
    regions = frame.geometry.representative_point().apply(region_crs)
    out = gpd.GeoSeries(index=frame.index, crs=4326, dtype="geometry")
    for crs, rows in frame.groupby(regions):
        projected = rows.geometry.to_crs(crs)
        simple = gpd.GeoSeries(shapely.coverage_simplify(projected.values, tolerance), index=rows.index, crs=crs)
        out.loc[rows.index] = simple.to_crs(4326)
    frame["geometry"] = out
    return frame


def polygonal(geometry):
    """Keep only the polygon parts of a geometry (make_valid can add stray lines or points)."""
    if geometry.geom_type in ("Polygon", "MultiPolygon"):
        return geometry
    parts = [g for g in getattr(geometry, "geoms", []) if g.geom_type in ("Polygon", "MultiPolygon")]
    return shapely.union_all(parts) if parts else shapely.Polygon()


def write_topology(path, frame, columns):
    """Gzipped TopoJSON with one GeometryCollection named `areas`, quantized to QUANTUM degrees."""
    frame = frame[columns + ["geometry"]].reset_index(drop=True)
    # Snap every vertex to the grid first; shared vertices snap identically, so edges stay shared.
    frame["geometry"] = shapely.remove_repeated_points(shapely.set_precision(frame.geometry.values, QUANTUM, mode="pointwise"))
    topo = topojson.Topology(frame, object_name="areas", prequantize=False, topology=True,
                             toposimplify=False, presimplify=False).to_dict()
    x0, y0 = (math.floor(v / QUANTUM) for v in frame.total_bounds[:2])
    arcs = []
    for arc in topo["arcs"]:
        points, last = [], None
        for x, y in arc:
            q = (round(x / QUANTUM) - x0, round(y / QUANTUM) - y0)
            if q != last:
                points.append(q)
                last = q
        if len(points) == 1:
            points.append(points[0])
        # Delta encoding, as in the TopoJSON spec.
        arcs.append([list(points[0])] + [[b[0] - a[0], b[1] - a[1]] for a, b in zip(points, points[1:])])
    topo["arcs"] = arcs
    topo["transform"] = {"scale": [QUANTUM, QUANTUM], "translate": [round(x0 * QUANTUM, 4), round(y0 * QUANTUM, 4)]}
    for geometry in topo["objects"]["areas"]["geometries"]:
        geometry.pop("id", None)
        geometry.pop("bbox", None)
    topo.pop("bbox", None)
    count = len(topo["objects"]["areas"]["geometries"])
    assert count == len(frame), (path, count, len(frame))
    payload = json.dumps(topo, separators=(",", ":")).encode()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(gzip.compress(payload, compresslevel=9, mtime=0))
    print(path, count, len(payload), path.stat().st_size, flush=True)


def rounded(value, digits=4):
    if isinstance(value, (list, tuple)):
        out = [rounded(item, digits) for item in value]
        if out and isinstance(out[0], list) and isinstance(out[0][0], float):
            # Drop repeated points that rounding creates inside a ring.
            out = [p for i, p in enumerate(out) if i == 0 or p != out[i - 1]]
        return out
    return round(value, digits)


def district_name(row):
    code = FIPS.get(row.STATEFP, row.STATEFP)
    return f"{code} at-large" if row.CD119FP in ("00", "98") else f"{code}-{row.CD119FP}"


def build_levels(args, out):
    geo = out / "levels" / "geo"
    # (archive, output name, geoid, name, USPS codes the area touches)
    national = (
        (args.county, "county", lambda r: r.GEOID, lambda r: f"{r.NAMELSAD}, {r.STUSPS}", lambda r: [r.STUSPS]),
        # Census codes delegate/at-large seats 98 or 00; HUD uses 00 for both.
        (args.cd, "cd", lambda r: r.STATEFP + ("00" if r.CD119FP == "98" else r.CD119FP), district_name,
         lambda r: [FIPS.get(r.STATEFP, r.STATEFP)]),
        # CBSA names end with their states, e.g. "Texarkana, TX-AR".
        (args.cbsa, "cbsa", lambda r: r.GEOID, lambda r: r.NAMELSAD, lambda r: r.NAME.rsplit(", ", 1)[1].split("-")),
    )
    for archive, name, geoid, label, states in national:
        if not archive:
            continue
        frame = gpd.read_file(f"zip://{archive}").to_crs(4326)
        if name == "cd":
            frame = frame[frame.CD119FP != "ZZ"]
        frame = frame.assign(geoid=[geoid(r) for r in frame.itertuples()], name=[label(r) for r in frame.itertuples()],
                             states=[states(r) for r in frame.itertuples()])
        write_topology(geo / f"{name}.bin", simplify(frame, TOLERANCE[name]), ["geoid", "name", "states"])
    if args.cousub:
        frame = gpd.read_file(f"zip://{args.cousub}").to_crs(4326)
        frame = frame.assign(geoid=frame.GEOID, name=frame.NAMELSAD + ", " + frame.NAMELSADCO)
        frame = simplify(frame, TOLERANCE["cousub"])
        for code, rows in frame.groupby("STUSPS"):
            write_topology(geo / "cousub" / f"{code}.bin", rows, ["geoid", "name"])


def main():
    parser = argparse.ArgumentParser()
    for name in ("zctas", "states", "county", "cd", "cbsa", "cousub"):
        parser.add_argument("--" + name)
    parser.add_argument("--out", default="data")
    args = parser.parse_args()
    out = Path(args.out)
    build_levels(args, out)
    if not args.states:
        return
    states = gpd.read_file(f"zip://{args.states}")
    states = states[states.STUSPS.notna()].to_crs(4326)
    simple = simplify(states, TOLERANCE["states"])
    features = [{"type": "Feature", "properties": {"code": row.STUSPS, "name": row.NAME},
                 "geometry": {**mapping(row.geometry), "coordinates": rounded(mapping(row.geometry)["coordinates"])}}
                for row in simple.itertuples()]
    (out / "states.json").write_text(json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":")))
    print(out / "states.json", len(features), flush=True)
    if not args.zctas:
        return

    zctas = gpd.read_file(f"zip://{args.zctas}")[["ZCTA5CE20", "geometry"]].to_crs(4326)
    points = zctas.copy()
    points.geometry = zctas.representative_point()
    located = gpd.sjoin(points, states[["STUSPS", "geometry"]], predicate="within", how="left")
    # A few coastal ZCTAs have a representative point outside the state
    # boundaries; assign the nearest state, while keeping each ZCTA in exactly one file.
    missing = located.STUSPS.isna()
    if missing.any():
        nearest = gpd.sjoin_nearest(points.loc[missing].to_crs(5070), states[["STUSPS", "geometry"]].to_crs(5070), how="left")
        located.loc[missing, "STUSPS"] = nearest.groupby(level=0).STUSPS.first()
    assignment = located.groupby(level=0).STUSPS.first()
    assert assignment.notna().all() and len(assignment) == len(zctas)
    zctas["state"] = assignment
    zctas["zip"] = zctas.ZCTA5CE20
    # Simplified nationally, so ZCTAs on either side of a state line keep one shared edge.
    zctas = simplify(zctas, TOLERANCE["zcta"])
    for code, rows in zctas.groupby("state"):
        write_topology(out / "zctas" / f"{code}.bin", rows, ["zip"])


if __name__ == "__main__":
    main()
