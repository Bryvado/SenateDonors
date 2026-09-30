"""Build the compact block lookups used to place geocoded contributions. Standard library only.

Run only when a boundary vintage changes. Inputs (all public Census files):
  --cd119        https://www2.census.gov/programs-surveys/decennial/rdo/mapping-files/2025/119-congressional-district-befs/cd119.zip
  --pl           directory of 2020 PL 94-171 state zips (xx2020.pl.zip), from
                 https://www2.census.gov/programs-surveys/decennial/2020/data/01-Redistricting_File--PL_94-171/
  --delineation  https://www2.census.gov/programs-surveys/metro-micro/geographies/reference-files/2023/delineation-files/list1_2023.xlsx

Writes data/lookups/:
  block_cd.csv.gz      start,cd        2020 block -> 119th Congress district (HUD form: at-large and delegate = 00)
  block_cousub.csv.gz  start,cousub    2020 block -> county subdivision GEOID as drawn (cb_2022 cousub,
                                        so Connecticut towns carry their planning-region county code)
  county_cbsa.csv      county,cbsa     county (cb_2024, planning regions in CT) -> CBSA, July 2023 delineation

Block tables are run-length encoded over sorted 15-digit block GEOIDs: a row gives the
value from its `start` block up to the next row's start ("" = no drawn area; the
contribution then falls back to the ZIP split for that level).
The county of a placed contribution is the first five digits of its county
subdivision GEOID (so Connecticut gets planning regions), else of its block.
Every value is checked against the geoids in data/levels/geo/*.bin.
"""

import argparse
import csv
import gzip
import io
import json
import sys
import zipfile
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from convert_crosswalks import cells as xlsx_cells  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]


def topo_geoids(path):
    data = json.loads(gzip.open(path).read())
    items = data["objects"]["areas"]["geometries"] if data["type"] == "Topology" else data["features"]
    return {item["properties"]["geoid"] for item in items}


def compress(values):
    """{15-digit block: value or None} -> [(first block of a run, value or "")].

    Blocks are sorted and a row is written only where the value changes, so a block's
    value is that of the last row whose first block sorts at or before it.
    """
    out, previous = [], object()
    for block in sorted(values):
        value = values[block] or ""
        if value != previous:
            out.append((block, value))
            previous = value
    return out


def write_table(path, header, table):
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wt", newline="", compresslevel=9) as f:
        writer = csv.writer(f, lineterminator="\n")
        writer.writerow(header)
        writer.writerows(table)
    print(path, len(table), "rows", path.stat().st_size, "bytes", flush=True)


def check(table, allowed, label):
    bad = sorted({value for _, value in table if value and value not in allowed})
    if bad:
        raise SystemExit(f"{label}: {len(bad)} values not in the boundary files, e.g. {bad[:10]}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cd119", required=True)
    parser.add_argument("--pl", required=True)
    parser.add_argument("--delineation", required=True)
    parser.add_argument("--out", default=str(ROOT / "data" / "lookups"))
    args = parser.parse_args()
    out = Path(args.out)
    geo = ROOT / "data" / "levels" / "geo"

    # 119th Congress: Census codes at-large seats 00 and delegates 98; HUD and the map use 00.
    cd = {}
    with zipfile.ZipFile(args.cd119) as z:
        with z.open("NationalCD119.txt") as f:
            for row in csv.DictReader(io.TextIOWrapper(f, "utf-8-sig")):
                code = row["CDFP"].strip()
                if code in ("", "ZZ"):
                    continue
                cd[row["GEOID"]] = row["GEOID"][:2] + ("00" if code == "98" else code)
    cd_table = compress(cd)
    check(cd_table, topo_geoids(geo / "cd.bin"), "cd")
    write_table(out / "block_cd.csv.gz", ("start", "cd"), cd_table)

    # County subdivisions: 2020 PL block records (summary level 750) give each block's county
    # and COUSUB code. Outside Connecticut the drawn geoid is state+county+code. Connecticut's
    # 2022 file uses planning regions as counties; town codes are unique within the state there.
    drawn = set()
    for path in sorted((geo / "cousub").glob("*.bin")):
        drawn |= topo_geoids(path)
    connecticut = {}
    for geoid in drawn:
        if geoid[:2] == "09":
            if geoid[5:] in connecticut:
                raise SystemExit(f"Connecticut town code {geoid[5:]} is not unique")
            connecticut[geoid[5:]] = geoid
    cousub, missing = {}, defaultdict(int)
    for path in sorted(Path(args.pl).glob("*2020.pl.zip")):
        with zipfile.ZipFile(path) as z:
            name = next(n for n in z.namelist() if n.endswith("geo2020.pl"))
            with z.open(name) as f:
                for line in io.TextIOWrapper(f, "latin-1"):
                    fields = line.split("|")
                    if fields[2] != "750":
                        continue
                    block, state, county, code = fields[9], fields[12], fields[14], fields[17]
                    geoid = connecticut.get(code) if state == "09" else state + county + code
                    if geoid not in drawn:
                        missing[state + county + code] += 1
                        geoid = None
                    cousub[block] = geoid
        print(path.name, len(cousub), flush=True)
    if missing:
        print("blocks in county subdivisions not drawn (left to the ZIP split):",
              sum(missing.values()), "in", len(missing), "subdivisions, e.g.", sorted(missing)[:10], flush=True)
    cousub_table = compress(cousub)
    write_table(out / "block_cousub.csv.gz", ("start", "cousub"), cousub_table)

    counties = topo_geoids(geo / "county.bin")
    unknown = sorted({block[:5] for block in cd if block[:2] != "09" and block[:5] not in counties})
    if unknown:
        print("2020 counties not drawn (left to the ZIP split):", unknown, flush=True)

    # County -> CBSA from the July 2023 delineation (the vintage of cb_2024 CBSA).
    header, table = None, []
    for row in xlsx_cells(args.delineation):
        if header is None:
            if {"CBSA Code", "FIPS State Code"} <= {v.strip() for v in row.values()}:
                header = {column: v.strip() for column, v in row.items()}
            continue
        record = {header[column]: v.strip() for column, v in row.items() if column in header}
        if record.get("CBSA Code", "").isdigit() and record.get("FIPS State Code", "").isdigit():
            table.append((record["FIPS State Code"].zfill(2) + record["FIPS County Code"].zfill(3), record["CBSA Code"]))
    table = sorted(set(table))
    check(table, topo_geoids(geo / "cbsa.bin"), "cbsa")
    with (out / "county_cbsa.csv").open("w", newline="") as f:
        writer = csv.writer(f, lineterminator="\n")
        writer.writerow(("county", "cbsa"))
        writer.writerows(table)
    print(out / "county_cbsa.csv", len(table), "rows", flush=True)


if __name__ == "__main__":
    main()
