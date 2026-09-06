# Uzbekistan Social Services Map Dashboard

Modern map-first dashboard built from the user's existing project data.

## Data included
- 20 exact 2026 territorial social service center records (name, region/district, location description, coordinates).
- 102 mapped 2027 proposal/object records.
- 208 district/city demographic and proposal-status rows.

No sample construction percentages, costs, contractors, or fake photo content are included.

## Map stack
- MapLibre GL JS 5.24
- OpenFreeMap Liberty basemap (no API key)
- Uzbekistan ADM1/ADM2 boundary overlay from `Rakhmatovdev/uz-map` (geoBoundaries-derived data)

## Run locally
```bash
python3 -m http.server 4173
```
Open `http://localhost:4173`.

## Marker semantics
- Green: 2026 center
- Red: 2027 proposal
- Blue: 2027 proposal whose district matches an official `2027-YIL TAKLIF` status in the 208-row sheet
- Purple: 2026 record explicitly associated with an “Inson markazi” location
