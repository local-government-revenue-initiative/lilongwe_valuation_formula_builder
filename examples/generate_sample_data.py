"""
Generates examples/sample_properties.csv.

THE DATA ARE SYNTHETIC. Plot numbers, coordinates, areas, characteristics and
values are invented with a fixed random seed so the tool can be demonstrated
and tested. They are not Lilongwe City Council records and must not be used
for any valuation.

Run:  python3 examples/generate_sample_data.py
"""
import csv
import math
import os
import random

random.seed(20260903)

ZONES = ["Area 3", "Area 10", "Area 18", "Area 25", "Kawale", "Biwi"]
STRUCT = ["Dwelling", "Dwelling", "Dwelling", "Shop / office", "Market / warehouse / industrial"]
WALL = ["Masonry / burnt brick / block", "Masonry / burnt brick / block", "Mud / unburnt brick", "Metal sheet / other"]
ROOF = ["Iron sheet", "Iron sheet", "Concrete / tile", "Thatch / other"]
ROAD = ["Good", "Average", "Average", "Bad"]

STRUCT_F = {"Dwelling": 1.0, "Shop / office": 1.25, "Market / warehouse / industrial": 0.8}
WALL_F = {"Masonry / burnt brick / block": 1.0, "Mud / unburnt brick": 0.7, "Metal sheet / other": 0.6}
ROOF_F = {"Iron sheet": 1.0, "Concrete / tile": 1.2, "Thatch / other": 0.75}
ROAD_F = {"Good": 1.15, "Average": 1.0, "Bad": 0.8}
ZONE_F = {"Area 3": 1.4, "Area 10": 1.5, "Area 18": 1.0, "Area 25": 0.9, "Kawale": 0.7, "Biwi": 0.75}

rows = []
for i in range(1, 41):
    zone = random.choice(ZONES)
    struct = random.choice(STRUCT)
    wall = random.choice(WALL)
    roof = random.choice(ROOF)
    road = random.choice(ROAD)
    water = random.random() < 0.6
    fence = random.random() < 0.5
    floors = 1 if random.random() < 0.8 else 2
    built = round(random.lognormvariate(math.log(110), 0.55), 1)
    if struct != "Dwelling":
        built = round(built * 1.8, 1)
    land = round(built * random.uniform(2.5, 6.0), 1)
    lat = round(-13.94 - random.random() * 0.07, 6)
    lng = round(33.74 + random.random() * 0.09, 6)
    imp = 25000 * built ** 0.9 * STRUCT_F[struct] * WALL_F[wall] * ROOF_F[roof] * (1.1 if fence else 1.0)
    imp *= math.exp(random.gauss(0, 0.18))
    lnd = 3000 * land ** 0.85 * ZONE_F[zone] * ROAD_F[road] * (1.12 if water else 1.0)
    lnd *= math.exp(random.gauss(0, 0.18))
    sampled = True  # every property carries valuer sample values (blank some cells to test unsampled properties)
    rows.append({
        "PlotNo": f"SYN-{i:03d}",
        "Description": f"Synthetic {struct.lower()} {i}",
        "Zone": zone,
        "Latitude": lat,
        "Longitude": lng,
        "Built_Area_m2": built,
        "Land_Area_m2": land,
        "Floors": floors,
        "Structure_Type": struct,
        "Wall_Material": wall,
        "Roof_Material": roof,
        "Road_Access": road,
        "Piped_Water": "Yes" if water else "No",
        "Fence": "Yes" if fence else "No",
        "Land_Value_MWK": f"{round(lnd, -3):,.0f}" if sampled else "",
        "Improvement_Value_MWK": f"{round(imp, -3):,.0f}" if sampled else "",
    })

here = os.path.dirname(os.path.abspath(__file__))
path = os.path.join(here, "sample_properties.csv")
with open(path, "w", newline="") as fh:
    w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
    w.writeheader()
    w.writerows(rows)
print("wrote", path, len(rows), "rows (synthetic)")
