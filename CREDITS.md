# Lantern Table credits

## Tabler Icons

- Source: https://github.com/tabler/tabler-icons
- License: MIT
- Vendored subset used for navigation and application controls.

## Game Icons

- Source: https://game-icons.net and https://github.com/game-icons/icons
- License: CC BY 3.0
- `battle-gear.svg`: Lorc
- `dungeon-gate.svg`: Delapouite

Icons made by Lorc and Delapouite and available on game-icons.net. The shipped SVG subset is used as monochrome UI artwork.

## Kokoro / kokoro-js (optional runtime download)

- Upstream: https://github.com/hexgrad/kokoro
- Model used by the browser option: `onnx-community/Kokoro-82M-v1.0-ONNX`
- License: Apache-2.0

Lantern Table does not redistribute the Kokoro model in this ZIP/container. If a player enables Enhanced Local Voice, the browser dynamically loads `kokoro-js` and downloads/caches the selected Kokoro model artifacts at runtime.

## Radiant (design reference only)

- Source: https://github.com/pbakaus/radiant
- License: MIT

Radiant demonstrates the same useful production pattern for ambient web effects (Canvas/WebGL, DPR-aware rendering, visibility pause, touch/mouse support). Lantern Table's shipped shader/effect code is original; Radiant source is not bundled as a runtime dependency.
