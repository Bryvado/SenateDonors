"""Create compact, per-state 2020 ZCTA geometry for the static map.

Run only when the Census cartographic boundaries need updating. Input archives:
https://www2.census.gov/geo/tiger/GENZ2020/shp/cb_2020_us_zcta520_500k.zip
https://www2.census.gov/geo/tiger/GENZ2020/shp/cb_2020_us_state_500k.zip
"""

import argparse
import gzip
import json
from pathlib import Path

import geopandas as gpd
from shapely.geometry import mapping


def compact_feature(geometry, properties, tolerance):
    geometry = geometry.simplify(tolerance, preserve_topology=True)
    if geometry.is_empty:
        return None
    result = mapping(geometry)
    def rounded(value):
        if isinstance(value, (list, tuple)):
            return [rounded(item) for item in value]
        return round(value, 4)
    result["coordinates"] = rounded(result["coordinates"])
    return {"type": "Feature", "properties": properties, "geometry": result}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--zctas", default="zctas.zip")
    parser.add_argument("--states", default="states.zip")
    parser.add_argument("--out", default="data")
    args = parser.parse_args()
    out = Path(args.out)
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
        features = [compact_feature(row.geometry, {"zip": row.ZCTA5CE20}, 0.006) for row in rows.itertuples()]
        features = [feature for feature in features if feature is not None]
        payload = json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":")).encode()
        (out / "zctas" / f"{code}.bin").write_bytes(gzip.compress(payload, compresslevel=9, mtime=0))
        print(code, len(features), flush=True)


if __name__ == "__main__":
    main()
