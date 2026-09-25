"""Convert HUD USPS ZIP crosswalk workbooks into compact CSVs (standard library only).

Download the quarterly ZIP-COUNTY, ZIP-CD, ZIP-CBSA and ZIP-COUNTY-SUB files
(and optionally ZIP-CBSA-DIVISION) from https://www.huduser.gov/portal/datasets/usps_crosswalk.html
into data/crosswalks/, then run:

    python3 scripts/convert_crosswalks.py data/crosswalks/*.xlsx

Each ZIP-NAME_MMYYYY.xlsx becomes data/crosswalks/ZIP-NAME.csv with columns
zip,geoid,state,res_ratio,tot_ratio. Delete the xlsx files afterwards; only the
CSVs are committed, so the scheduled refresh never needs a spreadsheet library.
"""

import argparse
import csv
import re
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
KEEP = ("zip", "geoid", "state", "res_ratio", "tot_ratio")


def shared_strings(book):
    try:
        root = ET.fromstring(book.read("xl/sharedStrings.xml"))
    except KeyError:
        return []
    return ["".join(t.text or "" for t in item.iter(NS + "t")) for item in root.iter(NS + "si")]


def rows(path):
    with zipfile.ZipFile(path) as book:
        strings = shared_strings(book)
        with book.open("xl/worksheets/sheet1.xml") as sheet:
            for _, element in ET.iterparse(sheet):
                if element.tag != NS + "row":
                    continue
                values = {}
                for cell in element.iter(NS + "c"):
                    column = re.match(r"[A-Z]+", cell.get("r")).group()
                    kind = cell.get("t")
                    if kind == "inlineStr":
                        value = "".join(t.text or "" for t in cell.iter(NS + "t"))
                    else:
                        v = cell.find(NS + "v")
                        value = "" if v is None else v.text or ""
                        if kind == "s":
                            value = strings[int(value)]
                    values[column] = value
                element.clear()
                yield [values.get(c, "") for c in sorted(values, key=lambda c: (len(c), c))]


def ratio(text):
    # Six decimals match HUD's published precision and keep the CSVs small.
    value = round(float(text or 0), 6)
    return f"{value:.6f}".rstrip("0").rstrip(".") or "0"


def convert(path, out_dir):
    name = re.sub(r"_\d{6}$", "", path.stem)
    target = out_dir / f"{name}.csv"
    iterator = rows(path)
    header = [h.strip().lower() for h in next(iterator)]
    index = [header.index(k) for k in KEEP]
    count = 0
    with target.open("w", newline="") as f:
        writer = csv.writer(f, lineterminator="\n")
        writer.writerow(KEEP)
        for row in iterator:
            if not row or not row[index[0]]:
                continue
            zip5, geoid, state = (row[i].strip() for i in index[:3])
            assert re.fullmatch(r"\d{5}", zip5), (path, zip5)
            assert "," not in geoid + state and '"' not in geoid + state
            writer.writerow((zip5, geoid, state, ratio(row[index[3]]), ratio(row[index[4]])))
            count += 1
    print(target, count)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("workbooks", nargs="+", type=Path)
    parser.add_argument("--out", type=Path, default=Path(__file__).resolve().parents[1] / "data" / "crosswalks")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    for path in args.workbooks:
        convert(path, args.out)


if __name__ == "__main__":
    main()
