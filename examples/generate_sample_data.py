"""
Generates examples/sample_properties.csv.

THE DATA ARE SYNTHETIC. Plot numbers, coordinates, areas, characteristics and
values are invented with a fixed random seed so the tool can be demonstrated
and tested. They are not Lilongwe City Council records and must not be used
for any valuation.

Properties are placed inside real Lilongwe Areas (from data/lilongwe_areas.js)
so that the tool's automatic Area detection has something to find, and land
values follow the 2011 roll medians (data/land_rates_default.js) with noise,
so the default land-rate schedule is roughly consistent with the sample.

Run from the repository root:  python3 examples/generate_sample_data.py
"""
import csv
import json
import math
import os
import random

random.seed(20260904)

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
N_PROPERTIES = 250


def load_js_global(path):
    txt = open(path, encoding="utf-8").read()
    return json.loads(txt[txt.index("=") + 1:].strip().rstrip(";"))


areas_fc = load_js_global(os.path.join(ROOT, "data", "lilongwe_areas.js"))
rates = load_js_global(os.path.join(ROOT, "data", "land_rates_default.js"))


def in_ring(pt, ring):
    x, y = pt
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def random_point(geom):
    polys = [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]
    outer = max(polys, key=lambda p: len(p[0]))[0]
    xs = [c[0] for c in outer]
    ys = [c[1] for c in outer]
    for _ in range(500):
        x = random.uniform(min(xs), max(xs))
        y = random.uniform(min(ys), max(ys))
        if in_ring((x, y), outer):
            return y, x
    cx = sum(xs) / len(xs)
    cy = sum(ys) / len(ys)
    return cy, cx


# Areas with a 2011 rate and a polygon, weighted towards the big residential areas
area_features = {str(f["properties"]["Area_ID"]): f for f in areas_fc["features"]}
usable = [a for a in rates["areas"] if a in area_features]
weights = [min(rates["areas"][a]["n"], 1500) for a in usable]

STRUCT = ["Dwelling", "Dwelling", "Dwelling", "Shop / office", "Market / warehouse / industrial"]
WALL = ["Masonry / burnt brick / block", "Masonry / burnt brick / block", "Mud / unburnt brick", "Metal sheet / other"]
ROOF = ["Iron sheet", "Iron sheet", "Concrete / tile", "Thatch / other"]
ROAD = ["Good", "Average", "Average", "Bad"]
STRUCT_F = {"Dwelling": 1.0, "Shop / office": 1.25, "Market / warehouse / industrial": 0.8}
WALL_F = {"Masonry / burnt brick / block": 1.0, "Mud / unburnt brick": 0.7, "Metal sheet / other": 0.6}
ROOF_F = {"Iron sheet": 1.0, "Concrete / tile": 1.2, "Thatch / other": 0.75}
ROAD_F = {"Good": 1.1, "Average": 1.0, "Bad": 0.9}

rows = []
for i in range(1, N_PROPERTIES + 1):
    area_id = random.choices(usable, weights=weights)[0]
    lat, lng = random_point(area_features[area_id]["geometry"])
    struct = random.choice(STRUCT)
    wall = random.choice(WALL)
    roof = random.choice(ROOF)
    road = random.choice(ROAD)
    fence = random.random() < 0.5
    floors = 1 if random.random() < 0.85 else 2
    built = round(random.lognormvariate(math.log(110), 0.55), 1)
    if struct != "Dwelling":
        built = round(built * 1.8, 1)
    land = round(built * random.uniform(2.5, 6.0), 1)
    land_rate = rates["areas"][area_id]["rate"] * math.exp(random.gauss(0, 0.12))
    land_value = land_rate * land
    improvement = 60000 * built ** 0.9 * STRUCT_F[struct] * WALL_F[wall] * ROOF_F[roof] * ROAD_F[road] * (1.1 if fence else 1.0)
    improvement *= math.exp(random.gauss(0, 0.18))
    total = land_value + improvement
    sampled = i % 2 == 0  # half the properties carry a valuer's total; blank the rest to mimic the real situation
    rows.append({
        "PlotNo": f"{area_id}/{i:03d}",
        "Description": f"Synthetic {struct.lower()} {i}",
        "Latitude": round(lat, 6),
        "Longitude": round(lng, 6),
        "Built_Area_m2": built,
        "Land_Area_m2": land,
        "Floors": floors,
        "Structure_Type": struct,
        "Wall_Material": wall,
        "Roof_Material": roof,
        "Road_Access": road,
        "Fence": "Yes" if fence else "No",
        "Total_Value_MWK": f"{round(total, -3):,.0f}" if sampled else "",
    })

path = os.path.join(HERE, "sample_properties.csv")
with open(path, "w", newline="") as fh:
    w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
    w.writeheader()
    w.writerows(rows)
print("wrote", path, len(rows), "rows (synthetic);", sum(1 for r in rows if r["Total_Value_MWK"]), "with a valuer total")
