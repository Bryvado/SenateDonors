"""Write per-level population denominators from the ACS 5-year table-based summary file.

Standard library only. Uses table B01003 (total population), which covers every
map level in one file and needs no API key:

    python3 scripts/build_population.py            # downloads the 2020-2024 file
    python3 scripts/build_population.py local.dat  # or reads a saved copy

Writes data/population/{state,zcta,county,cd,cbsa,cousub}.csv as geoid,population,
with geoids in the same form the map uses (USPS code for states, ZIP for ZCTAs,
HUD crosswalk codes for the other levels). Rerun when a new ACS release or a new
district map is adopted; nothing in the scheduled refresh depends on it.
"""

import argparse
import csv
import io
import urllib.request
from pathlib import Path

URL = "https://www2.census.gov/programs-surveys/acs/summary_file/2024/table-based-SF/data/5YRData/acsdt5y2024-b01003.dat"
VINTAGE = "ACS 2020-2024 5-year estimates, table B01003"
FIPS = {"01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT", "10": "DE",
        "11": "DC", "12": "FL", "13": "GA", "15": "HI", "16": "ID", "17": "IL", "18": "IN", "19": "IA",
        "20": "KS", "21": "KY", "22": "LA", "23": "ME", "24": "MD", "25": "MA", "26": "MI", "27": "MN",
        "28": "MS", "29": "MO", "30": "MT", "31": "NE", "32": "NV", "33": "NH", "34": "NJ", "35": "NM",
        "36": "NY", "37": "NC", "38": "ND", "39": "OH", "40": "OK", "41": "OR", "42": "PA", "44": "RI",
        "45": "SC", "46": "SD", "47": "TN", "48": "TX", "49": "UT", "50": "VT", "51": "VA", "53": "WA",
        "54": "WV", "55": "WI", "56": "WY", "60": "AS", "66": "GU", "69": "MP", "72": "PR", "78": "VI"}
# Summary-level prefix of GEO_ID -> (level, geoid conversion)
PREFIXES = {
    "0400000US": ("state", lambda code: FIPS.get(code)),
    "860Z200US": ("zcta", lambda code: code),
    "0500000US": ("county", lambda code: code),
    # Delegate seats are district 98 in Census files and 00 in the HUD crosswalk.
    "5001900US": ("cd", lambda code: code[:2] + ("00" if code[2:] == "98" else code[2:])),
    "310M700US": ("cbsa", lambda code: code),
    "0600000US": ("cousub", lambda code: code),
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source", nargs="?")
    parser.add_argument("--out", type=Path, default=Path(__file__).resolve().parents[1] / "data" / "population")
    args = parser.parse_args()
    if args.source:
        text = Path(args.source).read_text()
    else:
        with urllib.request.urlopen(URL, timeout=300) as response:
            text = response.read().decode()
    levels = {level: {} for level, _ in PREFIXES.values()}
    for row in csv.DictReader(io.StringIO(text), delimiter="|"):
        prefix, value = row["GEO_ID"][:9], row["B01003_E001"]
        if prefix in PREFIXES and value.lstrip("-").isdigit() and int(value) >= 0:
            level, convert = PREFIXES[prefix]
            geoid = convert(row["GEO_ID"][9:])
            if geoid:
                levels[level][geoid] = int(value)
    args.out.mkdir(parents=True, exist_ok=True)
    for level, values in levels.items():
        with (args.out / f"{level}.csv").open("w", newline="") as f:
            writer = csv.writer(f, lineterminator="\n")
            writer.writerow(("geoid", "population"))
            writer.writerows(sorted(values.items()))
        print(level, len(values), sum(values.values()))


if __name__ == "__main__":
    main()
