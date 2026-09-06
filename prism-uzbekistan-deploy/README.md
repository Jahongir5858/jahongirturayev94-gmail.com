# WFP PRISM — Uzbekistan bootstrap

This directory builds the official WFP-VAM PRISM frontend as an Uzbekistan-centered static site suitable for Cloudflare Pages.

## What this bootstrap does

- Pins upstream PRISM to commit `603710958a025f15507164ccdaa24bc2515b70dc`.
- Adds an `uzbekistan` country configuration at build time.
- Uses PRISM universal PMTiles administrative boundaries, so no private boundary server is required for the first version.
- Centers the map on Uzbekistan.
- Enables a small set of global WFP layers (rainfall, NDVI, temperature, population).
- Produces a static `dist/` directory with SPA redirects for Cloudflare Pages.

## Local / CI build

Node.js 20 is required.

```bash
npm run build
```

## Cloudflare Pages settings

Use the repository branch `prism-uzbekistan`.

- Root directory: `prism-uzbekistan-deploy`
- Build command: `npm run build`
- Build output directory: `dist`
- Node version: `20`

No Cloudflare secrets are required for the first static map build.

## Next customization

The bootstrap intentionally starts with PRISM universal administrative boundaries. The next step is to add Uzbekistan-specific region/district data and the planned social-service-center object layer, including status colors, photos and dashboard indicators.
