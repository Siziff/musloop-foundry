export const MODULE_ID = "musloop-foundry";
export const SOCKET = `module.${MODULE_ID}`;
export const ROOT_DIR = "musloop";            // Data/musloop/<slug>/
// before the rename tracks were imported into Data/<old name>/ — still scanned
export const LEGACY_ROOT_DIRS = ["musslop"];
// manifest "format" values: current + exports made before the rename
export const MANIFEST_FORMATS = ["musloop-loops", "musslop-loops"];
export const FLAG_SCOPE = "musloop";

export const log = {
  info: (...a) => console.log(`musloop |`, ...a),
  warn: (...a) => console.warn(`musloop |`, ...a),
  error: (...a) => console.error(`musloop |`, ...a),
};

export const i18n = (key, data) => data ? game.i18n.format(key, data) : game.i18n.localize(key);
