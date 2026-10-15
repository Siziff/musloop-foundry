# Testing without a Foundry licence

Foundry VTT is paid software, so these tests run the **real module code** in
headless Chromium against a small **Foundry API stub** (`www/foundry-stub.js`).
The stub follows the documented v12/v13 client API: hooks order
(`init → i18nInit → setup → ready`), `game.settings`, `game.keybindings`,
`game.socket` (module socket; the sender does not receive its own message),
`game.audio` (three AudioContexts that appear only after the first click,
`ctx.gainNode` = core Music volume), `FilePicker` (`browse` returns URL-encoded
paths, `upload` returns `false` on failure instead of throwing),
ApplicationV2 + Handlebars, `ui.notifications`, v12 Array / v13 Record
scene controls. There is **no global JSZip**, the same as real Foundry.

It is not Foundry: rendering details, Forge/Molten hosting and real network
latency are not covered. Do a final check in a real world before a release.

## Setup

```bash
pip install playwright numpy
playwright install chromium
```

You need a track exported from musloop with **Files → Foundry VTT (zip)**.

## Run

```bash
# GM + players over the socket: import → library → play → cues → late join → fade
python tests/test_module.py path/to/Track_foundry.zip

# The loop player alone, on the audio it actually renders
# (unzip the export into tests/www/track/ first)
python tests/test_player.py

# Edge cases: player not clicked yet, v12 controls, folder names with spaces,
# Music volume routing
python tests/test_edge.py path/to/Track_foundry.zip   # needs tests/www/track/ too
```

Set `CHROME=/path/to/chrome` to use a specific browser binary.
