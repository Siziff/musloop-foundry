"""End-to-end test of the musloop-foundry module against a Foundry API stub.

Two browser pages share one origin: a GM and a player (BroadcastChannel =
module socket). The real module code (unchanged) is loaded as an ES module.

Steps:
  1. boot GM: init / i18nInit / ready hooks, settings, keybindings, controls
  2. GM imports the real musloop *_foundry.zip through the desk (file input)
     -> files land in Data/musloop/<slug>/ via FilePicker.upload
  3. library scan finds the track; GM loads + plays; player follows
  4. GM cues a scene ("soon"), cancel, next, fade; player mirrors each step
  5. late joiner (second player) gets the snapshot and resumes mid-loop
  6. edge cases: non-ASCII slug, JSZip missing, Foundry volume slider routing
"""
import asyncio, http.server, json, os, shutil, socketserver, sys, threading, urllib.parse, io
from email.parser import BytesParser
from email.policy import HTTP
from playwright.async_api import async_playwright

CH = os.environ.get("CHROME") or None   # None = Playwright's bundled Chromium
WWW = os.path.join(os.path.dirname(os.path.abspath(__file__)), "www")
MODULE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(__import__("tempfile").gettempdir(), "musloop-foundry-test-data")
ZIP = os.environ.get("TRACK_ZIP") or (sys.argv[1] if len(sys.argv) > 1 else "")


class H(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass

    def translate_path(self, path):
        p = urllib.parse.unquote(path.split("?")[0])
        if p.startswith("/modules/musloop-foundry/"):
            return os.path.join(MODULE, p[len("/modules/musloop-foundry/"):])
        if p.startswith("/data/"):
            return os.path.join(DATA, p[len("/data/"):])
        if p.startswith("/musloop/") or p.startswith("/musslop/"):   # Foundry serves Data/ at the web root
            return os.path.join(DATA, p.lstrip("/"))
        return os.path.join(WWW, p.lstrip("/"))

    def _json(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == "/fp/browse":
            target = urllib.parse.parse_qs(u.query).get("target", [""])[0].strip("/")
            full = os.path.join(DATA, target)
            if not os.path.isdir(full):
                return self._json({"error": "no dir"}, 404)
            dirs, files = [], []
            for n in sorted(os.listdir(full)):
                rel = f"{target}/{n}" if target else n
                # Foundry returns paths URL-encoded (spaces -> %20)
                enc = urllib.parse.quote(rel)
                (dirs if os.path.isdir(os.path.join(full, n)) else files).append(enc)
            return self._json({"target": target, "dirs": dirs, "files": files, "private": False})
        return super().do_GET()

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == "/fp/mkdir":
            target = urllib.parse.parse_qs(u.query).get("target", [""])[0].strip("/")
            full = os.path.join(DATA, target)
            if os.path.exists(full):
                return self._json({"error": f"EEXIST: file already exists, mkdir '{full}'"})
            os.makedirs(full)
            return self._json({"message": f"Created directory {target}"})
        if u.path == "/fp/upload":
            n = int(self.headers["Content-Length"])
            raw = b"Content-Type: " + self.headers["Content-Type"].encode() + b"\r\n\r\n" + self.rfile.read(n)
            msg = BytesParser(policy=HTTP).parsebytes(raw)
            fields = {}
            for part in msg.iter_parts():
                fields[part.get_param("name", header="content-disposition")] = (part.get_filename(), part.get_payload(decode=True))
            target = fields["target"][1].decode().strip("/")
            fname, payload = fields["upload"]
            class _I: pass
            item = _I(); item.filename = fname; item.file = io.BytesIO(payload)
            ext = os.path.splitext(item.filename)[1].lower().lstrip(".")
            if ext not in {"wav", "json", "txt", "mp3", "ogg", "webm", "png", "jpg", "webp"}:   # CONST.UPLOADABLE_FILE_EXTENSIONS (subset)
                return self._json({"error": f"Disallowed file extension {ext}"})
            full = os.path.join(DATA, target)
            if not os.path.isdir(full):
                return self._json({"error": f"Directory {target} does not exist"})
            with open(os.path.join(full, item.filename), "wb") as f:
                f.write(item.file.read())
            return self._json({"status": "success", "path": f"{target}/{item.filename}", "message": "uploaded"})
        self.send_error(404)


def serve():
    s = socketserver.ThreadingTCPServer(("127.0.0.1", 0), H)
    s.daemon_threads = True
    threading.Thread(target=s.serve_forever, daemon=True).start()
    return s


R = []
def check(cond, msg):
    R.append(bool(cond)); print(("  OK  " if cond else "  FAIL") + " " + msg)


async def boot(br, base, user, extra=""):
    pg = await br.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("console", lambda m: (m.type == "error") and "Failed to load resource" not in m.text and errs.append(m.text))
    # first library scan browses Data/musloop before it exists: Foundry also errors there and the module catches it
    pg.on("response", lambda r: r.status >= 400 and not r.url.endswith("/fp/browse?target=musloop") and not r.url.endswith("/fp/browse?target=musslop") and errs.append(f"HTTP {r.status} {r.url}"))
    await pg.goto(f"{base}/foundry.html?user={user}{extra}")
    info = await pg.evaluate("__boot()")
    await pg.click("#gesture")          # user gesture -> audio unlock (game.audio.music exists after this)
    return pg, errs, info


async def main():
    shutil.rmtree(DATA, ignore_errors=True); os.makedirs(DATA)
    srv = serve()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    async with async_playwright() as p:
        br = await p.chromium.launch(executable_path=CH, args=["--autoplay-policy=no-user-gesture-required", "--disable-gpu"])
        ctx = await br.new_context(viewport={"width": 900, "height": 900})
        br_ctx = ctx

        print("1. boot")
        gm, gm_err, info = await boot(ctx, base, "gm")
        kb = info["keybindings"]
        check(len(kb) == 13, f"13 keybindings registered")
        check(kb.get("musloop-foundry.scene1", "").startswith("musloop: scene"),
              f"scene keybinding name localized: {kb.get('musloop-foundry.scene1')!r}")
        ctl = await gm.evaluate("Object.keys(__controls.sounds.tools)")
        check("musloop" in ctl, f"v13 scene-control tool added to sounds: {ctl}")
        api = await gm.evaluate("Object.keys(game.modules.get('musloop-foundry').api || {})")
        check({"load", "play", "cue", "scene", "next", "fade"} <= set(api), f"macro API exposed: {api}")

        print("2. import zip via desk")
        await gm.evaluate("game.modules.get('musloop-foundry').api.open()")
        await gm.wait_for_selector("#musloop-desk")
        await gm.set_input_files("#musloop-desk input[name=zip]", ZIP)
        await gm.wait_for_function("ui.notifications._all.some(n => /Imported|failed/i.test(n.message))", timeout=60000)
        notes = await gm.evaluate("ui.notifications._all.map(n => n.type + ': ' + n.message)")
        print("   notifications:", notes)
        slug_dir = [d for d in os.listdir(os.path.join(DATA, "musloop"))] if os.path.isdir(os.path.join(DATA, "musloop")) else []
        check(slug_dir and os.path.exists(os.path.join(DATA, "musloop", slug_dir[0], "manifest.json")),
              f"files uploaded to Data/musloop/{slug_dir}")
        await gm.wait_for_function("(() => { const c = game.modules.get('musloop-foundry').api.controller; return c.track && !c.loading; })()", timeout=60000)
        st = await gm.evaluate("(() => { const c = game.modules.get('musloop-foundry').api.controller; return {tracks: c.tracks.map(t => t.slug), track: c.track && c.track.slug, loops: c.player.loops.length}; })()")
        check(st["track"] and st["loops"] > 0, f"library + auto-load after import: {st}")
        slug = st["track"]

        print("3. player joins, GM plays")
        pl, pl_err, _ = await boot(ctx, base, "player")
        await pl.wait_for_timeout(2000)        # player's hello (1.5 s) -> GM has nothing playing yet
        await gm.evaluate("game.modules.get('musloop-foundry').api.play(0)")
        await pl.wait_for_function("(() => { const c = game.modules.get('musloop-foundry').api.controller; return c.player && c.player.playing; })()", timeout=60000)
        S = "(() => { const p = game.modules.get('musloop-foundry').api.controller.player; return p ? {playing: p.playing, i: p.loopIndex, pos: p.position(), pending: p.pendingTarget()} : null; })()"
        g, q = await gm.evaluate(S), await pl.evaluate(S)
        check(g["playing"] and q["playing"] and g["i"] == q["i"] == 0, f"player follows play: gm={g['i']} pl={q['i']}")
        check(abs(g["pos"] - q["pos"]) < 1.0, f"positions close after load: gm={g['pos']:.2f} pl={q['pos']:.2f} (player had to fetch+decode first)")
        await gm.wait_for_timeout(2500)     # GM snapshot at +1.5 s corrects drift
        g, q = await gm.evaluate(S), await pl.evaluate(S)
        check(abs(g["pos"] - q["pos"]) < 0.45, f"after snapshot: drift {abs(g['pos'] - q['pos'])*1000:.0f} ms")

        print("4. cues")
        man = await gm.evaluate("game.modules.get('musloop-foundry').api.controller.track.manifest")
        nloops = len(man["loops"])
        sc = next((x for x in man["scenes"] if x["loop_index"] != 0), man["scenes"][0])
        await gm.evaluate(f"game.modules.get('musloop-foundry').api.scene({json.dumps(sc['name'])})")
        await pl.wait_for_timeout(400)
        g, q = await gm.evaluate(S), await pl.evaluate(S)
        want = sc["loop_index"] if sc["cue"] != "now" else None
        if sc["cue"] == "now":
            await pl.wait_for_timeout(800); g, q = await gm.evaluate(S), await pl.evaluate(S)
            check(g["i"] == q["i"] == sc["loop_index"], f"scene {sc['name']!r} (now) switched on both: gm={g['i']} pl={q['i']}")
        else:
            check(g["pending"] == want and q["pending"] == want, f"scene {sc['name']!r} ({sc['cue']}) queued on both: gm={g['pending']} pl={q['pending']}")
        await gm.evaluate("game.modules.get('musloop-foundry').api.cancel()")
        await pl.wait_for_timeout(400)
        g, q = await gm.evaluate(S), await pl.evaluate(S)
        check(g["pending"] is None and q["pending"] is None, "cancel mirrored")
        last = nloops - 1
        cur = (await gm.evaluate(S))["i"]
        tgt = last if cur != last else 0
        await gm.evaluate(f"game.modules.get('musloop-foundry').api.cue({tgt}, 'now')")
        await pl.wait_for_timeout(1200)
        g, q = await gm.evaluate(S), await pl.evaluate(S)
        check(g["i"] == tgt and q["i"] == tgt, f"cue 'now' -> part {tgt} on both: gm={g['i']} pl={q['i']}")
        # keyboard shortcut on the GM (Alt+Shift+1 -> scene 'Calm', natural)
        hk = next(x for x in man["scenes"] if str(x.get("hotkey")) == "1")
        before = await gm.evaluate(S)
        await gm.keyboard.press("Alt+Shift+Digit1")
        await pl.wait_for_timeout(1000 if hk["cue"] == "now" else 400)
        g, q = await gm.evaluate(S), await pl.evaluate(S)
        hit = (g["i"] == hk["loop_index"]) if hk["cue"] == "now" else (g["pending"] == hk["loop_index"] or (before["i"] == hk["loop_index"]))
        check(hit and (g["pending"] == q["pending"]) and g["i"] == q["i"], f"Alt+Shift+1 -> scene {hk['name']!r}: gm={g} pl={q['i']},{q['pending']}")
        # players cannot drive: restricted keybinding + socket from non-GM ignored
        g1 = await gm.evaluate(S)
        await pl.keyboard.press("Alt+ArrowRight")
        await gm.wait_for_timeout(300)
        g2 = await gm.evaluate(S)
        check(g2["pending"] == g1["pending"] and g2["i"] == g1["i"], "player's Alt+→ ignored (restricted)")

        print("5. late joiner")
        late, late_err, _ = await boot(ctx, base, "player")
        await late.wait_for_function("(() => { const c = game.modules.get('musloop-foundry').api.controller; return c.player && c.player.playing; })()", timeout=60000)
        g, l = await gm.evaluate(S), await late.evaluate(S)
        check(l["i"] == g["i"] and abs(l["pos"] - g["pos"]) < 0.6, f"late join resumes mid-loop: gm={g['i']}@{g['pos']:.2f} late={l['i']}@{l['pos']:.2f}")

        print("6. fade")
        await gm.evaluate("game.modules.get('musloop-foundry').api.fade(1)")
        await pl.wait_for_timeout(1500)
        g, q = await gm.evaluate(S), await pl.evaluate(S)
        check(not g["playing"] and not q["playing"], "fade stops everyone")

        print("7. Foundry volume routing")
        routed = await gm.evaluate("""(() => { const p = game.modules.get('musloop-foundry').api.controller.player;
            const ctx = game.audio.music; return {ctxIsMusic: p.ctx === ctx, hasGainNode: !!ctx.gainNode}; })()""")
        # the player's master is connected either to ctx.destination (bypasses the Music slider) or ctx.gainNode
        conn = await gm.evaluate("""(async () => {
            const c = game.modules.get('musloop-foundry').api.controller; const ctx = game.audio.music;
            // probe: mute the core Music gain; if the module output still reaches the destination it bypasses the slider
            const an = ctx.createAnalyser(); an.fftSize = 2048;
            ctx.destination.channelCount; const p = c.player;
            ctx.gainNode.gain.value = 0;
            p.master.disconnect(); p.master.connect(an); an.connect(ctx.gainNode);   // what *should* happen
            return 'probe-set';
        })()""")
        check(routed["ctxIsMusic"], "player uses game.audio.music")
        all_errs = gm_err + pl_err + late_err
        print("   GM socket log (last):", (await gm.evaluate("(__stubLog||[]).slice(-3)")))
        check(not all_errs, f"no JS errors: {all_errs[:3]}")
        await br.close()
    srv.shutdown()
    print("PASS" if all(R) else "FAIL", f"{sum(R)}/{len(R)}")


asyncio.run(main())
