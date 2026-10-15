"""Drive musslop-foundry's loop-player.js in Chromium on a real musslop export
and check the audio it produces.

Scenario (one continuous session):
  play A1 -> let A1 loop once (seam) -> cue C1 "soon" (phrase) -> cue B1
  "natural" then cancel -> cue D1 "now" -> fade out.
Checks: playback state machine + the recorded signal (no silent gaps at
loop seams / transitions, transition lands near the planned time, fade
reaches silence)."""
import asyncio, base64, functools, http.server, json, os, socketserver, threading, sys
import numpy as np
from playwright.async_api import async_playwright

CH = os.environ.get("CHROME") or None   # None = Playwright's bundled Chromium
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "www")
MODULE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class H(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        p = path.split("?")[0]
        if p.startswith("/module/"):
            return os.path.join(MODULE, p[len("/module/"):])
        return os.path.join(ROOT, p.lstrip("/"))
    def log_message(self, *a): pass


def serve():
    s = socketserver.ThreadingTCPServer(("127.0.0.1", 0), H)
    s.daemon_threads = True
    threading.Thread(target=s.serve_forever, daemon=True).start()
    return s


results = []
def check(cond, msg):
    results.append(bool(cond))
    print(("  OK  " if cond else "  FAIL") + " " + msg)


async def main():
    srv = serve()
    url = f"http://127.0.0.1:{srv.server_address[1]}/player-test.html"
    async with async_playwright() as p:
        br = await p.chromium.launch(executable_path=CH, args=["--autoplay-policy=no-user-gesture-required", "--disable-gpu"])
        pg = await br.new_page()
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: m.type == "error" and errs.append(m.text))
        await pg.goto(url)
        await pg.wait_for_function("window.setup")
        info = await pg.evaluate("setup()")
        print("loaded:", info)
        loops = info["loops"]
        A1 = loops[0][1]
        await pg.evaluate("start(0)")
        await pg.wait_for_timeout(500)
        s = await pg.evaluate("state()")
        check(s["playing"] and s["loopIndex"] == 0 and s["loopCount"] == 1, f"play A1: {s}")

        # wait past the first seam -> pass 2
        await pg.wait_for_timeout(int((A1 + 1.2) * 1000))
        s = await pg.evaluate("state()")
        check(s["loopIndex"] == 0 and s["loopCount"] == 2, f"A1 looped (pass 2): loopCount={s['loopCount']}")

        # cue C1 at the next phrase
        d = await pg.evaluate("(() => { mark('cue C1 soon'); return T.p.cue(2, 'soon'); })()")
        s = await pg.evaluate("state()")
        check(d and d.get("mode") == "soon" and d.get("atPos") is not None and s["pending"] == 2,
              f"cue soon -> {d}, pending={s['pending']}, eta={s['eta'] and round(s['eta'],2)}")
        soon_eta = s["eta"]
        await pg.wait_for_timeout(int((soon_eta + 0.8) * 1000))
        s = await pg.evaluate("state()")
        check(s["loopIndex"] == 2 and s["pending"] is None, f"landed in C1: {s['loopIndex']}")
        await pg.evaluate("mark('in C1')")

        # cue B1 natural, then cancel
        d = await pg.evaluate("T.p.cue(1, 'natural')")
        s1 = await pg.evaluate("state()")
        await pg.evaluate("T.p.cancelCue()")
        s2 = await pg.evaluate("state()")
        check(d["mode"] == "natural" and s1["pending"] == 1 and s2["pending"] is None,
              f"natural cue armed ({s1['pending']}) then cancelled ({s2['pending']})")

        # cue D1 now
        await pg.evaluate("(() => { mark('cue D1 now'); return T.p.cue(3, 'now'); })()")
        await pg.wait_for_timeout(1200)
        s = await pg.evaluate("state()")
        check(s["loopIndex"] == 3, f"'now' switched to D1: {s['loopIndex']}")
        await pg.wait_for_timeout(1500)
        await pg.evaluate("(() => { mark('fade'); T.p.fadeOut(1.5); })()")
        await pg.wait_for_timeout(2200)
        s = await pg.evaluate("state()")
        check(not s["playing"], "fade out -> stopped")
        await pg.wait_for_timeout(300)

        data = await pg.evaluate("dump()")
        check(not errs, f"no JS errors ({errs[:2]})")
        await br.close()
    srv.shutdown()

    # ---- signal analysis -----------------------------------------------------
    sr = data["sr"]
    y = np.frombuffer(base64.b64decode(data["b64"]), dtype=np.float32)
    ev = dict((n, t) for n, t in data["events"])
    print("recorded", round(len(y) / sr, 1), "s; events", {k: round(v, 2) for k, v in ev.items()})
    win = int(0.02 * sr)
    rms = np.sqrt(np.convolve(y ** 2, np.ones(win) / win, mode="same"))
    # music should be continuous from ~0.1 s after play until the fade starts
    t_play = ev["play 0"]
    lo = int((t_play + 0.4) * sr)  # skip start-up: page timers jitter before audio begins
    hi = int((ev["fade"]) * sr)
    seg = rms[lo:hi]
    ref = np.median(seg)
    gaps = np.where(seg < ref * 0.02)[0]
    longest = 0
    if len(gaps):
        runs = np.split(gaps, np.where(np.diff(gaps) != 1)[0] + 1)
        longest = max(len(r) for r in runs) / sr
    if len(gaps):
        for r in runs:
            if len(r)/sr > 0.03: print(f"    quiet run at {(lo+r[0])/sr:.2f}-{(lo+r[-1])/sr:.2f}s")
    check(longest < 0.03, f"no dropouts while playing (longest near-silence {longest*1000:.0f} ms; median rms {ref:.3f})")
    # around the A1 seam (t ≈ A1 duration after play) level must not dip
    seam = int((t_play + 0.06 + A1) * sr)
    around = rms[seam - int(0.05 * sr): seam + int(0.05 * sr)]
    check(around.min() > ref * 0.05, f"A1 loop seam has no hole (min rms {around.min():.3f})")
    # after fade: silence
    tail = rms[int((ev["fade"] + 1.7) * sr):]
    check(len(tail) == 0 or tail.max() < 0.01, f"silent after fade (max rms {tail.max() if len(tail) else 0:.4f})")
    print("PASS" if all(results) else "FAIL", f"{sum(results)}/{len(results)}")


asyncio.run(main())
