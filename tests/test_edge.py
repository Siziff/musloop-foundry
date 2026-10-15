import asyncio, os, shutil, sys
ZIP_EDGE = sys.argv[1]
sys.argv = ["x"]
exec(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "test_module.py")).read().split("async def boot")[0])
from playwright.async_api import async_playwright
C = "game.modules.get('musloop-foundry').api"
async def page(br, base, q, gesture=True):
    pg = await br.new_page(); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("console", lambda m: m.type == "error" and errs.append(m.text))
    await pg.goto(base + "/foundry.html?" + q); await pg.evaluate("__boot()")
    if gesture: await pg.click("#gesture")
    return pg, errs
async def main():
    shutil.rmtree(DATA, ignore_errors=True); os.makedirs(os.path.join(DATA, "musloop"))
    shutil.copytree(os.path.join(WWW, "track"), os.path.join(DATA, "musloop", "Village_Consort"))
    srv = serve(); base = f"http://127.0.0.1:{srv.server_address[1]}"
    async with async_playwright() as p:
        br = await p.chromium.launch(executable_path=CH, args=["--autoplay-policy=no-user-gesture-required"])
        ctx = await br.new_context()
        print("A. player has not clicked yet (audio locked) when GM plays")
        gm, ge = await page(ctx, base, "user=gm")
        pl, pe = await page(ctx, base, "user=player", gesture=False)
        await pl.wait_for_timeout(1800)
        await gm.evaluate(f"(async () => {{ await {C}.load('Village_Consort'); {C}.play(0); }})()")
        await pl.wait_for_timeout(2500)
        print("   player errors:", pe[:2])
        print("   player playing before click:", await pl.evaluate(f"!!({C}.controller.player && {C}.controller.player.playing)"))
        await pl.click("#gesture")
        for w in (1500, 3000, 6000):
            await pl.wait_for_timeout(w if w == 1500 else w // 2)
            both = await pl.evaluate(f"(() => {{ const p = {C}.controller.player; return p ? [p.playing, p.loopIndex, p.position()] : null; }})()"), await gm.evaluate(f"[{C}.controller.player.loopIndex, {C}.controller.player.position()]")
            st, g = both
            print(f"   ~{w/1000:.1f}s after click: player", st and [st[0], st[1], round(st[2], 2)], "gm", [g[0], round(g[1], 2)], "drift", st and round(abs(st[2]-g[1]), 2))
        print("B. Foundry v12 shape")
        g12, e12 = await page(ctx, base, "user=gm&v=12")
        tools = await g12.evaluate("__controls.find(c => c.name === 'sounds').tools.map(t => [t.name, typeof t.onClick])")
        await g12.evaluate(f"(async () => {{ await {C}.load('Village_Consort'); {C}.play(1); }})()")
        await g12.wait_for_timeout(800)
        print("   v12 tools:", tools, "| playing:", await g12.evaluate(f"{C}.controller.player.playing"), "| errors:", e12[:2])
        print("C. JSZip not global (as in real Foundry) -> module loads vendor/jszip.min.js")
        gz, ez = await page(ctx, base, "user=gm")
        await gz.evaluate(f"{C}.open()"); await gz.wait_for_selector("#musloop-desk")
        await gz.set_input_files("#musloop-desk input[name=zip]", ZIP_EDGE)
        await gz.wait_for_function("ui.notifications._all.some(n => /Imported|failed/i.test(n.message))", timeout=60000)
        print("   ", await gz.evaluate("ui.notifications._all.slice(-1)[0].type + ': ' + ui.notifications._all.slice(-1)[0].message"))
        print("D. folder with a space in Data/musloop (hand-unpacked)")
        shutil.copytree(os.path.join(WWW, "track"), os.path.join(DATA, "musloop", "Village Consort"))
        gs, es = await page(ctx, base, "user=gm")
        print("   library:", await gs.evaluate(f"{C}.controller.tracks.map(t => t.slug)"))
        await gs.evaluate(f"(async () => {{ await {C}.load('Village Consort'); {C}.play(0); }})()")
        await gs.wait_for_timeout(600)
        print("   playing:", await gs.evaluate(f"{C}.controller.player.playing"), "| errors:", es[:2])
        print("F. track imported before the rename (Data/musslop/, format musslop-loops)")
        legacy = os.path.join(DATA, "musslop", "Old_Track")
        shutil.copytree(os.path.join(WWW, "track"), legacy)
        gl, el = await page(ctx, base, "user=gm")
        libs = await gl.evaluate(f"{C}.controller.tracks.map(t => [t.slug, t.dir, t.manifest.format])")
        print("   library:", libs)
        await gl.evaluate(f"(async () => {{ await {C}.load('Old_Track'); {C}.play(0); }})()")
        await gl.wait_for_timeout(600)
        print("   legacy track playing:", await gl.evaluate(f"{C}.controller.player.playing"), "| errors:", el[:2])
        print("E. Music volume slider routing")
        r = await gs.evaluate(f"""(() => {{ const p = {C}.controller.player, ctx = game.audio.music;
            // count the master node's outputs: connected to ctx.gainNode (core volume) or straight to destination
            return {{ hasCoreGain: !!ctx.gainNode, note: 'MusloopPlayer master -> ' + (p._dest === ctx.gainNode ? 'ctx.gainNode (Music slider applies)' : 'ctx.destination (bypasses slider)') }}; }})()""")
        print("  ", r)
        await br.close()
    srv.shutdown()
asyncio.run(main())
