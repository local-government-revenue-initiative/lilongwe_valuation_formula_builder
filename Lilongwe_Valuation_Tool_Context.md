# Context: Property Valuation Formula Tool for Lilongwe City Council

**Purpose of this document:** background for building a tool that lets LCC staff construct and apply a formula-based (mass/CAMA-style) property valuation, using LCC's own asset/property data. Prepared for use with Claude Code.

---

## 1. Program and goal

LoGRI (Local Government Revenue Initiative) operates in Lilongwe under the AMALI program, branded externally as "AMALI." The engagement is with Lilongwe City Council (LCC). Mayor Peter Alex Banda's stated goal is "Cleaning and Greening" — expanded tree planting and improved solid waste/garbage collection. AMALI's job on the resource side is to help LCC identify the costs of that agenda and, more importantly, the revenue to sustainably finance it. The dominant lever identified for financing is **own-source revenue from property rates**, since roughly 80% of a typical rates-funded budget goes to service delivery obligations under Malawi law.

Key LCC counterparts: Mayor Peter Alex Banda; CEO Clement Stambuli; Director of Finance Eliam Banda; Director of Legal Services Yasin Maoni; Director of Planning Chichizgani Msumba; Director of Landscape Allan Kwanjana.

## 2. The core problem this tool addresses

LCC's Quinquennial Valuation Roll (QVR) is ~17 years old (last full roll ~2011 — see `QVR_2011_COMBINEDADAMS5.xls`). Two separate gaps compound each other:

- **Coverage gap**: Building-footprint analysis (Overture Maps, July 2026) estimates **291,510 buildings ≥25 m²** within the current city boundary alone (395,429 total buildings), rising to **343,699** across the current boundary plus the proposed expansion area. Against this, LCC currently bills only **~47,000–50,000 properties** (`Property_List.csv`, ~50,093 rows). A large majority of the physical building stock is simply never valued or billed.
- **Compliance gap**: Of properties that *are* billed, only roughly 1 in 6 pays anything in a given year. This makes compliance improvement a larger near-term revenue lever than rate increases — notable because LCC just implemented 50–76% rate increases in April 2026.

A modern, formula-based (mass/CAMA) valuation approach is the agreed strategic response to the coverage gap: it is far cheaper and faster than individual expert valuations at city scale, and is the only realistic way to bring hundreds of thousands of untaxed buildings into the roll.

## 3. Legal framework the formula must satisfy

Two statutes govern this. **Do not treat these as flexible defaults — the tool's outputs must be structurally compatible with them.**

### Local Government Act 1998 (as amended 2017) — Part VII (ss. 61–107)
- **s.65**: Council must maintain a valuation roll, revalued at least every 5 years.
- **s.66**: Supplementary valuation roll — used for new/omitted/materially-changed properties, updated at least every 12 months. This is the mechanism identified for a low-risk pilot (see §6).
- **s.67**: Valuation and preparation of rolls must be undertaken by a valuer registered under the Land Economy Surveyors, Valuers, Estate Agents and Auctioneers Act (now superseded by the PVA 2024 registration regime — see below). **A licensed valuer must design, supervise, and certify the formula/model** — the tool supports a valuer's work, it does not replace their legal role.
- **s.68(1)**: Every valuation roll and supplementary roll must **show separately**: (a) total valuation, (b) value of assessable land, (c) value of assessable improvements. **The tool's output schema must carry land value and improvement value as distinct fields**, not just a combined total.
- **s.68(2)**: Valuation is based on market value / rental value approach (post-2017 amendment moved the basis from capital value to **estimated rental value**). Historically the Act specifies valuing improvements assuming "reasonable condition" rather than actual condition — LoGRI's own legislative review (`230418RevenueServices_Links_Analysis...pdf` / `220831Proposed_Legislation_Review...pdf`) flags this as a problem, arguing that condition *should* logically be considered, but as currently drafted **the statute does not treat condition as a permitted formula input in the "reasonable condition" reading**. Treat this as a live legal ambiguity, not settled — flag it in the tool rather than silently deciding it.
- **s.63 / s.64**: Defines assessable property (land + improvements) and exemptions (streets, cemeteries, public open space, etc.) and fixed-sum levies for non-designated areas.
- **s.73**: Valuers are not required to inspect building interiors — supports an exterior/desk-based + remote-imagery data collection approach.

### Property Valuation Act 2024 (Act 26 of 2024)
This is the newer, more detailed statute governing valuer registration and practice, and the mechanism to unlock formula/mass valuation formally.
- **s.42(1)–(2)(c)**: The **Minister may, on the recommendation of the Board [of Valuers], make regulations** prescribing "procedures for assessing land and property rates under single and mass valuations." This is the **ministerial regulation pathway** — the preferred legal route to formally sanction a mass-appraisal/formula method, because it arrives as government policy (Ministry of Lands → Board) rather than a city-level petition. Note: s.42(1) still requires **Board recommendation** — the ministerial route does not bypass the Board, it changes the political framing.
- **ss. 20, 22(4)(g)**: Board of Valuers approval of valuation *methods* is a separate statutory gate from the s.42 regulations. Both gates need to be cleared for a formula method to have full legal standing.
- Open institutional questions (unresolved as of last check): whether a Commissioner for Valuation has been appointed since the PVA commenced (Jan 2025); whether any s.42 regulations or Board-approved standards have actually been issued; LoGRI/AMALI's standing at the Ministry of Lands.
- LoGRI's own legislative review argues the PVA's list of approved methods (s.32/s.41) is silent on points-based/mass appraisal methods specifically, and recommends the Board be urged to approve one — this has **not been confirmed as done**.

**Bottom line for the tool**: the underlying formula methodology (points-based / CAMA / regression-based mass appraisal) is well precedented internationally and technically ready to build now. Its *legal* deployment at full scale depends on unresolved Board/Ministerial approvals. The pragmatic near-term path is to **pilot the formula on LCC's own council-owned rental estates via a s.66 supplementary valuation** — this stays within LCC's own authority and does not require waiting on s.42 regulations, while demonstrating the method.

## 4. Recommended valuation methodology (points-based / CAMA)

This is described in detail in two project reference documents: `Implementing_a_PointsBased_Valuation_System_for_Property_Taxation.pdf` and `Module_1_5_Designing_Locally_Appropriate_Valuation_Strategies.pdf`. Summary of the approach the tool should implement:

1. **Geospatial register**: identify taxable buildings from aerial/satellite imagery (already done at a screening level — see `Lilongwe_Building_Stock_Report.docx`; GeoPackage footprint layer available).
2. **Field survey of observable characteristics**: enumerators record only externally observable features (roof material, wall material, number of floors, road access/condition, location/zone) — no interior entry needed (LGA s.73 supports this).
3. **Expert sample valuation**: licensed valuers estimate rental (or capital) value for a small sample (commonly ~5% of properties).
4. **Statistical calibration**: a regression model (commonly OLS / log-linear) is fit on the sampled expert valuations against the observable characteristics, producing a formula (a set of weighted "points" or coefficients) that is then applied to every property, sampled or not.
5. **Transparency**: the formula/coefficients should be publishable — a stated design goal, both for legal defensibility and anti-corruption (a published formula anyone can check reduces manipulation).

Practical modeling notes from the guidance materials, relevant to how the tool should be built:
- Rental value (not capital value) is the metric aligned with LGA s.68(2) post-2017.
- Continuous variables (rental value, property size) are typically **log-transformed** before regression, since raw values are heavily left-skewed; predictions are exponentiated back to level values for output.
- Categorical variables prone to multicollinearity (e.g., road type) are commonly **amalgamated into simplified categories** (e.g., "Good"/"Average"/"Bad") to keep the model stable and its logic easy to explain to taxpayers and future administrations.
- **NAV 2009** (LCC's existing billing/valuation system) is sufficient to run a formula-based valuation as-is — the goal is not to replace it but to feed verified, formula-derived values into it.

## 5. Data currently in hand

- **`Property_List.csv`** — ~50,093 currently-billed properties, keyed by `PlotNo`. Columns: `No.`, `PlotNo`, `Description`, `Zone`, `Zone Name`, `Owner Customer No.`, `Owner Customer Name`, `Address`, `City`, `Address Register No.`, `Rateable Value`. **No geometry/coordinates** — this is a billing register, not a spatial dataset. Note: numeric fields (e.g. Rateable Value) are stored as strings with thousands-separator commas and need cleaning before numeric conversion.
- **GeoPackage building-footprint layer** (Overture Maps buildings theme, release 2026-07-22) — `Lilongwe_Buildings_Overture.gpkg` (395,429 buildings in the current city boundary) and `Lilongwe_Expansion_Buildings_Overture.gpkg` (72,210 in the proposed expansion area). Each footprint has size, a ≥25m² "taxable" flag, source (OSM/Google Open Buildings/Microsoft ML), and edit-date attributes. **Building type classification is present for <1% of records** — not usable as a formula input at present without a field survey.
- **`FIXED_ASSET_REGISTER.xlsx`** and **`AMALI_DATAESTATES_SECTION.xlsx`** — LCC-owned asset inventories (the pilot candidate set: gazetted council rental estates, markets, car parks).
- **`QVR_2011_COMBINEDADAMS5.xls`** — the last full valuation roll (~2011), useful as a historical baseline / sanity check but 17 years stale.
- LCC financial statements (`202425_LCC_Financial_Statements...pdf`, June 2026 management accounts) — confirm property rates and market/car-park/license fee income lines, useful for revenue-impact modeling once formula outputs exist.
- **No field-survey dataset of building characteristics currently exists.** This is a gap: the formula needs observable characteristics (roof, walls, floors, road access, zone) per property, and none of the current files contain this at scale. The tool should be built assuming this data will need to be collected (e.g., via KoboToolbox) and does not yet exist for the full building stock.

## 6. What "the tool" should actually do

The ask is a **simple internal tool for LCC staff** to build and apply a valuation formula against the council's own asset/property database — not a public-facing system. Recommended shape, based on the methodology above and the realistic near-term pilot:

- **Input**: a spreadsheet/CSV of properties (initially the council-asset pilot set, eventually the wider stock) with observable characteristics per property, plus a small subset with expert-assigned sample values.
- **Calibration step**: fit a regression (log-linear OLS is the standard, well-precedented choice) on the sampled/expert-valued properties to derive weights/coefficients for each characteristic.
- **Apply step**: run the fitted formula across all properties (sampled and unsampled) to generate a predicted rental value, then split into land value and improvement value components per LGA s.68(1) — the tool's output schema needs distinct fields for these, not just a total.
- **Transparency/output**: the coefficients and the resulting valuation logic should be exportable/viewable in a form non-technical LCC staff and the public could, in principle, inspect — this is a stated design goal, not just a nice-to-have.
- **Staff usability**: the target user is LCC finance/valuation staff, not a data scientist — the interface should let them re-run/update the formula (e.g., annually, or when new sample valuations come in) without needing to touch code directly, even if the underlying engine is R or Python.
- **Council-asset pilot scope**: LCC's own rental estates are the intended first application — a small, well-bounded set (gazetted estates/markets from the asset register) that can be processed via an LGA s.66 supplementary valuation, without waiting on PVA s.42 regulatory approval. This is the also the natural connector between the AMALI Data Track (asset digitization) and Resource Track (revenue/valuation reform) mandates, which have previously been misaligned in scope.

## 7. Open questions to keep visible (not yet resolved)

- Has a Commissioner for Valuation been appointed under the PVA 2024?
- Have any s.42 regulations or Board-approved valuation methods/standards been issued?
- What is LoGRI/AMALI's current standing with the Ministry of Lands on this?
- Is IFMIS integration feasible for moving verified/formula-derived values into LCC's billing system (NAV 2009)?
- Exact scope/count of the council-asset pilot set (gazetted estates) — confirm current figures against `FIXED_ASSET_REGISTER.xlsx` / `AMALI_DATAESTATES_SECTION.xlsx` rather than assuming a fixed number, as these should be treated as the source of truth over any prior verbal estimate.

## 8. File locations

- Dropbox (local): `C:\Users\edtro\LoGRI Dropbox\LoGRI Master Folder\1. Program\5. Partnerships\15. AMALI\2. City Engagements\Colette, Marie, Zoé\3. Lilongwe\2. Resources\`
- Dropbox (MCP path): `Colette, Marie, Zoé` → `3. Lilongwe` → `2. Resources`
- Notion: "Lilongwe City, Malawi" page and sub-pages, LoGRI workspace.
- Most of the above files are also loaded into this Claude project's knowledge base.
