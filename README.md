# Shipwright Harbor and Dock

This repository holds the public parts of [Shipwright OS](https://sksenapati007.github.io/shipwright-harbor/), a
custom firmware for the Xteink X4 Classic e-reader:

- **Harbor** (`harbor/`): the companion web app (PWA). Open https://sksenapati007.github.io/shipwright-harbor/ in
  Chrome or Edge and connect to the device over Bluetooth. It sends books and ships, sets the time, backs up settings,
  and sends calendar, weather, news, Gmail and Drive snapshots and account data.
- **Dock** (`dock/`): the catalogue of ships (small Lua apps). The device installs them over Wi-Fi from
  https://sksenapati007.github.io/shipwright-harbor/dock/catalog.json and checks each file's SHA-256.

GitHub Pages publishes both from this repository (`.github/workflows/pages.yml`) on every push to `main`.

The files here are copied from the main Shipwright repository by its `scripts/publish_harbor.sh`. Make changes there.

## Build and test Harbor

```bash
cd harbor
npm ci
npm run typecheck
npm test          # unit tests (the device contract test needs the firmware simulator and is skipped here)
npm run e2e       # Playwright end-to-end tests against a fake device
npm run build     # dist/
```

## Update the Dock

```bash
python3 dock/build_catalog.py         # regenerates dock/catalog.json (sizes, sha256) and validates it
python3 dock/build_catalog.py --check # fails when the catalogue is stale
```

A published ship file never changes without a version bump, because devices check its SHA-256.

## Documents

- Sync protocol test vectors: `docs/protocol/`
- Google sign-in setup: `docs/guides/GOOGLE-CLIENT-ID.md`
- Stock data providers: `docs/guides/`

## Licence

MIT (see `LICENSE`). Third-party parts and their licences are in `NOTICE`.
