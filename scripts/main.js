import { MODULE_ID, SOCKET, log } from "./const.js";
import { controller } from "./sync.js";
import { toggleDesk, getDesk } from "./app.js";

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "volume", {
    name: "MUSLOOP.Setting.Volume", hint: "MUSLOOP.Setting.VolumeHint",
    scope: "client", config: true, type: Number, default: 0.8,
    range: { min: 0, max: 1, step: 0.01 },
    onChange: v => controller.player?.setVolume(v),
  });
  game.settings.register(MODULE_ID, "packSources", {
    name: "MUSLOOP.Setting.PackSources", hint: "MUSLOOP.Setting.PackSourcesHint",
    scope: "world", config: true, type: String, default: "",
    onChange: () => controller.refreshPacks(),
  });
  game.settings.register(MODULE_ID, "tails", {
    name: "MUSLOOP.Setting.Tails", hint: "MUSLOOP.Setting.TailsHint",
    scope: "client", config: true, type: Boolean, default: true,
    onChange: v => { if (controller.player) controller.player.tails = v; },
  });

  // Keybindings (GM only for transport; the desk toggle for everyone)
  game.keybindings.register(MODULE_ID, "desk", {
    name: "MUSLOOP.Keybind.Desk", editable: [{ key: "KeyM", modifiers: ["Alt"] }],
    onDown: () => { toggleDesk(); return true; },
  });
  game.keybindings.register(MODULE_ID, "next", {
    name: "MUSLOOP.Keybind.Next", editable: [{ key: "ArrowRight", modifiers: ["Alt"] }], restricted: true,
    onDown: () => { controller.advance(); return true; },
  });
  game.keybindings.register(MODULE_ID, "cancel", {
    name: "MUSLOOP.Keybind.Cancel", editable: [{ key: "Backspace", modifiers: ["Alt"] }], restricted: true,
    onDown: () => { controller.cancel(); return true; },
  });
  game.keybindings.register(MODULE_ID, "fade", {
    name: "MUSLOOP.Keybind.Fade", editable: [{ key: "KeyF", modifiers: ["Alt"] }], restricted: true,
    onDown: () => { controller.fade(2.5); return true; },
  });
});

// Scene keybindings need a formatted name ("scene 3"); translations are only
// loaded at i18nInit (still before setup, so registering keybindings is allowed).
Hooks.once("i18nInit", () => {
  for (let n = 1; n <= 9; n++) {
    game.keybindings.register(MODULE_ID, `scene${n}`, {
      name: game.i18n.format("MUSLOOP.Keybind.Scene", { n }),
      editable: [{ key: `Digit${n}`, modifiers: ["Alt", "Shift"] }], restricted: true,
      onDown: () => {
        const sc = (controller.track?.manifest.scenes || []).find(s => String(s.hotkey) === String(n));
        if (sc) { controller.applyScene(sc); return true; }
        return false;
      },
    });
  }
});

Hooks.once("ready", async () => {
  game.socket.on(SOCKET, msg => controller.handle(msg));
  await controller.refreshLibrary();
  // players: ask the GM what is playing (late join)
  if (!game.user.isGM) setTimeout(() => controller.hello(), 1500);
  // when the player first clicks (audio unlocked) and music is already running, re-sync
  if (!game.user.isGM && game.audio.locked !== false) game.audio.unlock?.then(() => controller.hello());
  // expose a small API for macros: game.modules.get("musloop-foundry").api
  const mod = game.modules.get(MODULE_ID);
  if (mod) mod.api = {
    controller,
    open: toggleDesk,
    load: slug => controller.loadTrack(slug),
    play: i => controller.play(i),
    cue: (i, mode) => controller.cue(i, mode),
    scene: name => { const sc = (controller.track?.manifest.scenes || []).find(s => s.name === name); if (sc) controller.applyScene(sc); },
    next: () => controller.advance(),
    cancel: () => controller.cancel(),
    stop: () => controller.stop(),
    fade: sec => controller.fade(sec),
  };
  log.info("ready", `${controller.tracks.length} track(s) in Data/musloop`);
});

// Scene-control button (sounds layer). v13: controls is a Record; v12: an Array.
Hooks.on("getSceneControlButtons", controls => {
  const tool = {
    name: "musloop",
    title: "MUSLOOP.Control",
    icon: "fa-solid fa-music",
    button: true,
    visible: true,
  };
  if (Array.isArray(controls)) {
    // v12
    const sounds = controls.find(c => c.name === "sounds") || controls.find(c => c.name === "token");
    if (sounds) sounds.tools.push({ ...tool, onClick: () => toggleDesk() });
  } else {
    // v13+
    const group = controls.sounds || controls.tokens;
    if (group) group.tools.musloop = { ...tool, order: Object.keys(group.tools).length, onChange: () => toggleDesk() };
  }
});

// Re-render the desk when users come and go (the "N players hear this" line)
Hooks.on("userConnected", () => getDesk()?._throttledRender?.());
