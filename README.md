# Lilongwe Property Valuation Tool

An install-free tool for Lilongwe City Council (LCC) staff to value land and buildings with a published formula, starting with the council-estate pilot. It runs in a web browser from a folder on a shared drive or from the hosted copy at https://lilongwe-valuation-formula-builder.vercel.app. Nothing is sent to a server. Satellite imagery needs an internet connection; everything else works offline.

## Quick start

1. Open `index.html` (or the hosted URL).
2. **Properties**: click *Import CSV / Excel…* and choose `examples/sample_properties.csv` to see the tool working with synthetic data. Areas are detected from the coordinates.
3. **Land rates**: check the rates for the Areas concerned; set the uplift factor.
4. **Results**: the model fits itself on the sample properties; read the summary, then export the roll and the report.

The sample file is synthetic: plot numbers, coordinates, areas and values are invented. It exists only to demonstrate the tool.

## How a property is valued

- **Land value** = land rate for the property's Area (or Sector) × parcel area in m². The rates are a schedule on the Land rates tab. It starts from the median land value per m² in each Area in the 2011 valuation roll (2011 capital values, Kwacha), which the registered valuer brings to today's values by editing rates or setting one uplift factor. Areas without a rate use a city-wide default and are flagged.
- **Building value** = base value × area term × Π(1 + weight) over the property's characteristics. The weights are fitted by least squares on the sample: for each sample property, the valuer's total value minus the land value is the building value the model learns from (the residual method, PVA 2024 s.22(4)(f)).
- **Total value** = land + buildings. The roll reports all three separately (LGA s.68(1)).

Model forms: log-linear (default), log-log (the LoGRI guidance form) and linear; *Compare forms* lists R², RMSE, leave-one-out RMSE, COD and PRD side by side. Any weight can be locked to a council-chosen value; the others refit around it (offset method, identical to `lm(y ~ x + offset(...))` in R) and the cost in R² is shown.

## Interface

- **Simplified** (default): Properties, Land rates, Results, Help. The model fits automatically.
- **Advanced** adds Characteristics (edit the list, starter list, Sector land use as a characteristic), Model (form, locks, full statistics, form comparison), Sector-level rates, per-property rate overrides, and the valuer details that print on the report.

**Saved models.** In Advanced mode the current settings (form, characteristics in the model, locked weights, smearing) can be saved under a name. Saved models are compared on fit statistics, on weights term by term, and on their effect on the roll (building and total values, share of properties moving by more than 10 %). Any saved model can be made active, refitted after data changes, or exported with per-property values to Excel; the report lists the alternatives considered.

Properties can be imported from CSV/Excel with a column-mapping step, or added by hand. Each can be pinned on the map (Area and Sector detected automatically from the built-in boundaries; otherwise from the plot number, e.g. `46/1/232` is Area 46, Sector 46/1), have rooftops and the parcel traced on satellite imagery, carry photos and notes. *Save project* writes everything, photos included, to a single `.json` file; work is also autosaved in the browser.

## Files

```
index.html, css/styles.css        the application (AMALI styling)
js/engine.js                      regression engine (pure JS, unit-tested)
js/valuation.js                   land rates, residual samples, per-property valuation (unit-tested)
js/geo.js                         Area/Sector lookup from coordinates or plot numbers (unit-tested)
js/formula.js                     weights presentation, formula text, calculation sheets, method statement
js/io.js, js/mapping.js, js/storage.js, js/app.js
data/lilongwe_areas.js            Area boundaries (from the GeoPackage, generated)
data/lilongwe_sectors.js          Sector boundaries with land use and ownership (generated)
data/land_rates_default.js        2011 roll medians per Area and Sector (generated)
data/gpkg_to_geojson.py           regenerates the boundary files from lilongwe_valuation_tool_gis_files.gpkg
data/build_land_rates.py          regenerates the default rates from the QVR 2011 extract
examples/                         synthetic sample data and its generator
r/reproduce_fit.R                 tidyverse script that refits the exported model with lm()
tests/                            unit tests (node --test) and a Playwright browser test
styling/example_files/            AMALI brand guide, palette and logos
```

## Legal points the tool keeps visible

- **PVA 2024 s.22**: basis, method, assumptions and data must be stated and explained. The report carries a method statement; each property has a calculation sheet.
- **PVA 2024 ss.24–25**: validity period and certification by the registered valuer. The report has a certification block filled from the valuer details; the tool does not replace the certification.
- **PVA 2024 s.42(2)(c)**: regulations on mass valuation were not confirmed as issued. Intended use is a pilot on council-owned property through an LGA s.66 supplementary roll.
- **LGA s.67, s.68**: registered valuer; land, improvements and total reported separately; value basis (rental after 2017) used consistently for rates and sample totals.
- **Condition variables** are flagged because of the Act's "reasonable condition" wording.

## Deployment

Static site; `vercel.json` sets no build step and security headers. Vercel deploys `main` to the production URL; other branches get preview URLs. Browser storage is per site, so use *Save project* / *Open project…* to move work between the hosted copy and a local folder.

## Development and testing

```
node --test tests/engine.test.js tests/valuation.test.js   # unit tests
python3 tests/independent_check.py                         # regenerates tests/expected.json (exact rational OLS)
npm install --no-save playwright && node tests/e2e.spec.js # browser test
python3 data/gpkg_to_geojson.py && python3 data/build_land_rates.py && python3 examples/generate_sample_data.py
```

`r/reproduce_fit.R` was written without an R installation and has not been run.
