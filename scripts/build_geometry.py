"""Create detailed, per-state 2020 ZCTA geometry for the static map.

Run only when the Census boundaries need updating. Each input is optional, so
one layer can be rebuilt at a time. Input archives:
  --zctas   https://www2.census.gov/geo/tiger/TIGER2020/ZCTA520/tl_2020_us_zcta520.zip
  --states  https://www2.census.gov/geo/tiger/GENZ2020/shp/cb_2020_us_state_500k.zip
  --county  https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_us_county_500k.zip
  --cd      https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_us_cd119_500k.zip
  --cbsa    https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_us_cbsa_500k.zip
  --cousub  https://www2.census.gov/geo/tiger/GENZ2022/shp/cb_2022_us_cousub_500k.zip

--zctas needs --states. The level files are written to OUT/levels/geo/ with
properties {geoid, name}; geoids match the HUD crosswalk CSVs. The 2022 county
subdivision vintage is used because it matches the HUD 06/2026 crosswalk best
(2024 drops about 1,200 Arkansas geoids the crosswalk still uses). The HUD CD
crosswalk uses 119th Congress districts (checked against Texas PLANC2333, the
2025 mid-decade plan, which agreed far less); see CLAUDE.md.
"""

import argparse
import gzip
import json
from pathlib import Path

import geopandas as gpd
from shapely.geometry import mapping


def compact_feature(geometry, properties, tolerance=None):
    if tolerance is not None:
        geometry = geometry.simplify(tolerance, preserve_topology=True)
    if geometry.is_empty:
        return None
    result = mapping(geometry)
    def rounded(value):
        if isinstance(value, (list, tuple)):
            return [rounded(item) for item in value]
        # Seven digits retain narrow boundaries without creating self-intersections
        # from coordinate rounding (five digits invalidated dozens of ZCTAs).
        return round(value, 7)
    result["coordinates"] = rounded(result["coordinates"])
    return {"type": "Feature", "properties": properties, "geometry": result}


FIPS = {"01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT", "10": "DE",
        "11": "DC", "12": "FL", "13": "GA", "15": "HI", "16": "ID", "17": "IL", "18": "IN", "19": "IA",
        "20": "KS", "21": "KY", "22": "LA", "23": "ME", "24": "MD", "25": "MA", "26": "MI", "27": "MN",
        "28": "MS", "29": "MO", "30": "MT", "31": "NE", "32": "NV", "33": "NH", "34": "NJ", "35": "NM",
        "36": "NY", "37": "NC", "38": "ND", "39": "OH", "40": "OK", "41": "OR", "42": "PA", "44": "RI",
        "45": "SC", "46": "SD", "47": "TN", "48": "TX", "49": "UT", "50": "VT", "51": "VA", "53": "WA",
        "54": "WV", "55": "WI", "56": "WY", "60": "AS", "66": "GU", "69": "MP", "72": "PR", "78": "VI"}


def write_packed(path, features):
    features = [feature for feature in features if feature is not None]
    payload = json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":")).encode()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(gzip.compress(payload, compresslevel=9, mtime=0))
    print(path, len(features), path.stat().st_size, flush=True)


def district_name(row):
    code = FIPS.get(row.STATEFP, row.STATEFP)
    return f"{code} at-large" if row.CD119FP in ("00", "98") else f"{code}-{row.CD119FP}"


def build_levels(args, out):
    geo = out / "levels" / "geo"
    # (archive, output name, tolerance in degrees, geoid, name, USPS codes the area touches)
    national = (
        (args.county, "county", 0.001, lambda r: r.GEOID, lambda r: f"{r.NAMELSAD}, {r.STUSPS}", lambda r: [r.STUSPS]),
        # Census codes delegate/at-large seats 98 or 00; HUD uses 00 for both.
        (args.cd, "cd", 0.001, lambda r: r.STATEFP + ("00" if r.CD119FP == "98" else r.CD119FP), district_name,
         lambda r: [FIPS.get(r.STATEFP, r.STATEFP)]),
        # CBSA names end with their states, e.g. "Texarkana, TX-AR".
        (args.cbsa, "cbsa", 0.0015, lambda r: r.GEOID, lambda r: r.NAMELSAD, lambda r: r.NAME.rsplit(", ", 1)[1].split("-")),
    )
    for archive, name, tolerance, geoid, label, states in national:
        if not archive:
            continue
        frame = gpd.read_file(f"zip://{archive}").to_crs(4326)
        if name == "cd":
            frame = frame[frame.CD119FP != "ZZ"]
        write_packed(geo / f"{name}.bin", [
            compact_feature(row.geometry, {"geoid": geoid(row), "name": label(row), "states": states(row)}, tolerance)
            for row in frame.itertuples()])
    if args.cousub:
        frame = gpd.read_file(f"zip://{args.cousub}").to_crs(4326)
        for code, rows in frame.groupby("STUSPS"):
            write_packed(geo / "cousub" / f"{code}.bin", [
                compact_feature(row.geometry, {"geoid": row.GEOID, "name": f"{row.NAMELSAD}, {row.NAMELSADCO}"}, 0.0003)
                for row in rows.itertuples()])


def main():
    parser = argparse.ArgumentParser()
    for name in ("zctas", "states", "county", "cd", "cbsa", "cousub"):
        parser.add_argument("--" + name)
    parser.add_argument("--out", default="data")
    args = parser.parse_args()
    out = Path(args.out)
    build_levels(args, out)
    if not args.zctas:
        return
    (out / "zctas").mkdir(parents=True, exist_ok=True)

    states = gpd.read_file(f"zip://{args.states}")
    states = states[states.STUSPS.notna()].to_crs(4326)
    state_features = [
        compact_feature(row.geometry, {"code": row.STUSPS, "name": row.NAME}, 0.025)
        for row in states.itertuples()
    ]
    (out / "states.json").write_text(json.dumps({"type": "FeatureCollection", "features": state_features}, separators=(",", ":")))

    zctas = gpd.read_file(f"zip://{args.zctas}")[["ZCTA5CE20", "geometry"]].to_crs(4326)
    points = zctas.copy()
    points.geometry = zctas.representative_point()
    located = gpd.sjoin(points, states[["STUSPS", "geometry"]], predicate="within", how="left")
    # A few coastal ZCTAs have a representative point outside the simplified state
    # boundaries; assign the nearest state, while keeping each ZCTA in exactly one file.
    missing = located.STUSPS.isna()
    if missing.any():
        nearest = gpd.sjoin_nearest(points.loc[missing].to_crs(5070), states[["STUSPS", "geometry"]].to_crs(5070), how="left")
        located.loc[missing, "STUSPS"] = nearest.groupby(level=0).STUSPS.first()
    assignment = located.groupby(level=0).STUSPS.first()
    assert assignment.notna().all() and len(assignment) == len(zctas)
    zctas["state"] = assignment
    for code, rows in zctas.groupby("state"):
        # TIGER/Line retains the original detailed boundaries. About 10 meters
        # of simplification controls download size without losing city blocks.
        features = [compact_feature(row.geometry, {"zip": row.ZCTA5CE20}, 0.0001) for row in rows.itertuples()]
        features = [feature for feature in features if feature is not None]
        payload = json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":")).encode()
        (out / "zctas" / f"{code}.bin").write_bytes(gzip.compress(payload, compresslevel=9, mtime=0))
        print(code, len(features), flush=True)


if __name__ == "__main__":
    main()
