# Lilongwe Valuation Formula Builder

A small, install-free tool for Lilongwe City Council (LCC) staff to build and apply a formula-based (points-based / CAMA) property valuation to the council's own property list, starting with the council-estate pilot.

It runs entirely in a web browser from a folder on a shared drive. Nothing is sent to a server. Satellite imagery needs an internet connection; everything else works offline.

## Quick start

1. Copy this folder to a shared drive (or clone the repository).
2. Open `index.html` in Chrome, Edge or Firefox.
3. On the **Properties** tab click **Import CSV / XLSX…** and choose `examples/sample_properties.csv` to see the tool working with synthetic data.
4. Go to **Models & weights** and click **Fit / refit** on both models.
5. Go to **Valuation roll** to see the values and export them.

The sample file is synthetic: plot numbers, coordinates, areas and values are invented. It exists only to demonstrate the tool.

## What the tool does

**1. Properties.** Import the asset list (CSV or Excel; a column-mapping screen matches columns to fields and turns extra columns into characteristics), or add properties by hand. For each property you can:

- drop a pin on the map, type coordinates, or use the device GPS;
- trace one or more rooftops on the satellite image and enter floors per building; built area = sum of rooftop area × floors;
- trace the parcel boundary to get land area;
- type areas directly instead (the source, traced / manual / imported, is recorded and exported);
- enter a valuer's **land value** and **improvement value** for sample properties (optional);
- attach photos (resized to about 1024 px) and notes.

If only a total value is known, **Split entered totals…** divides it using a land share you choose and records that assumption in the notes.

**2. Characteristics.** Define the externally observable features: categorical (wall material, road access), yes/no (fence, piped water) or numeric. Each applies to the land model, the improvement model or both. A starter list adapted from the LoGRI guidance note can be added with one click and edited, and the property Zone field can be used directly as a location characteristic in the land model. Features marked as condition variables raise a legal flag (see below).

**3. Models & weights.** Two ordinary least squares regressions are fitted, one for land value on land area and land characteristics, one for improvement value on built area and building characteristics. This keeps land and improvement values separate as LGA s.68(1) requires.

- Model forms: **log-linear** (default), **log-log** (the LoGRI guidance form) and **linear**. "Compare forms" fits all three and lists R², RMSE, leave-one-out RMSE, COD and PRD side by side.
- Weights are shown the way the Sierra Leone systems show them: a base value, an area weight, and a percentage per feature relative to the base property. Confidence is colour-coded (confident p < 0.05, mixed p < 0.20, weak, locked, base).
- Any weight can be **locked** to a council-chosen value. The other weights are refitted around it (the offset method, identical to `lm(y ~ x + offset(...))` in R) and "R² without locks" shows the cost of the manual setting.
- Fit measures: R², adjusted R², R² on values, RMSE, leave-one-out RMSE (over-fitting check), median ratio, COD and PRD (the IAAO ratio-study statistics).
- Checks are listed for small samples, rare categories, duplicated columns and excluded rows.

**4. Valuation roll.** The formula is applied to every property with an area. Exports: the roll as CSV or XLSX (land, improvement and total values, area sources, sample values, ratio, flags, all characteristics), the weights table as CSV, and a printable model report. Each property has a **calculation sheet** that walks from base value through each adjustment to the final value, so a taxpayer can check it by hand.

**Save project** writes everything, photos included, to a single `.json` file for backup or hand-over. Work is also autosaved in the browser.

## The formula

Log-linear (default):

    ln(value) = base + w_area × area + Σ weight_feature
    value     = Base value × (1 + w_area)^area × Π (1 + weight_feature)

Log-log (LoGRI guidance note and the Sierra Leone SOP):

    ln(value) = base + w_area × ln(area) + Σ weight_feature
    value     = Base value × area^w_area × Π (1 + weight_feature)

Linear:

    value = base + w_area × area + Σ amount_feature

A note on the default: with untransformed area inside a log model, each extra square metre multiplies value by the same factor, so value grows exponentially with area. That can misbehave across a stock that runs from 25 m² houses to multi-thousand square metre markets. Use "Compare forms" and look at RMSE and COD on values before settling on a form.

## Legal points the tool keeps visible

- **Registered valuer.** Under LGA 1998 s.67 and the Property Valuation Act 2024 a registered valuer must design, supervise and certify the valuation. The tool supports that work; it does not replace it.
- **Separate land and improvement values** (LGA s.68(1)) are produced by two separate models and exported as separate columns.
- **Value basis** (LGA s.68(2), estimated rental value after the 2017 amendment) is a project setting recorded in the report. Use one basis consistently for all sample values.
- **Condition variables.** The Act values improvements assuming "reasonable condition". Whether actual condition may enter the formula is unresolved; characteristics marked as condition variables are flagged in the Characteristics tab and the report.
- **Mass valuation approval.** Formal sanction under PVA 2024 s.42 regulations and Board of Valuers approval had not been confirmed. The intended near-term use is a pilot on council-owned estates through an LGA s.66 supplementary roll.

## Files

```
index.html            the application
css/styles.css
js/engine.js          regression engine (pure JS, also used by the tests)
js/formula.js         weights presentation, formula text, calculation sheets
js/io.js              CSV/XLSX import with column mapping; exports
js/mapping.js         Leaflet map, tracing, geodesic areas
js/storage.js         IndexedDB autosave, project file save/load, photo resizing
js/app.js             user interface
vendor/               Leaflet 1.9.4, Leaflet.draw 1.0.4, SheetJS 0.18.5 (pinned, offline)
examples/             synthetic sample data and its generator
r/reproduce_fit.R     tidyverse script that refits the exported models with lm()
tests/                unit tests (node --test) and a Playwright browser test
```

## Deployment

The tool is a static site, so it can be hosted anywhere that serves files over HTTPS. `vercel.json` configures Vercel with no build step and standard security headers (geolocation stays allowed for the "Use device GPS" button).

- **Vercel dashboard:** import the GitHub repository, choose framework preset "Other", leave the build command empty and set the output directory to `.`. Every push to the connected branch redeploys.
- **Command line:** `npx vercel --prod` from the project folder.

Two things to know about the hosted version:

- Browser storage is per site. Work saved while opening `index.html` from a drive does not appear on the hosted URL, and the reverse. Use **Save project** and **Open project…** to move a project between the two.
- Hosting the page does not put any council data on a server; everything still stays in each user's browser. If a login is needed later, that is the point to add a shared database (for example Supabase behind `js/storage.js`). Vercel's own password protection for the site is a paid feature.

## Development and testing

```
node --test tests/engine.test.js        # engine unit tests
python3 tests/independent_check.py      # regenerates tests/expected.json (exact rational OLS)
npm install --no-save playwright         # once, for the browser test
node tests/e2e.spec.js                   # import, fit, lock, trace, export, reload
python3 examples/generate_sample_data.py # regenerate the synthetic sample
```

The unit tests compare the engine's coefficients, standard errors and R² against an independent exact-arithmetic least-squares solution, including a locked-weight case and a rank-deficient case.

`r/reproduce_fit.R` was written without an R installation available and has not been run. It reads the two export files and refits each model with `lm()`, printing the tool's coefficients next to R's.

## Out of scope for this version

Multi-user editing, NAV 2009 / IFMIS integration, automatic zone assignment from GIS layers, bulk import of Overture building footprints, user accounts.
