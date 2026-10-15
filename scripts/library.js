/**
 * Track library: discovers musslop exports under Data/musslop/<slug>/ and
 * imports *_foundry.zip files there (upload via FilePicker).
 */
import { MODULE_ID, ROOT_DIR, log } from "./const.js";

/** JSZip: Foundry does not expose it as a global — use ours (vendor/jszip.min.js, MIT). */
async function getJSZip() {
  if (globalThis.JSZip) return globalThis.JSZip;
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = `modules/${MODULE_ID}/vendor/jszip.min.js`;
    s.onload = resolve;
    s.onerror = () => reject(new Error("could not load vendor/jszip.min.js"));
    document.head.appendChild(s);
  });
  if (!globalThis.JSZip) throw new Error("JSZip failed to initialise");
  return globalThis.JSZip;
}

/** FilePicker.browse returns URL-encoded paths ("My%20Track"); compare/fetch decoded names. */
const decodePath = p => { try { return decodeURIComponent(p); } catch (e) { return p; } };

/** Folder name for a track: keep letters of any script (Cyrillic, CJK…), like musslop's export. */
export function slugify(s) {
  return String(s || "").normalize("NFC").replace(/[^\p{L}\p{N}_\-]+/gu, "_").replace(/^_+|_+$/g, "") || "track";
}

function FP() {
  // v13: foundry.applications.apps.FilePicker.implementation ; v12: global FilePicker
  return globalThis.foundry?.applications?.apps?.FilePicker?.implementation || globalThis.FilePicker;
}

async function ensureDir(path) {
  const fp = FP();
  try { await fp.createDirectory("data", path); }
  catch (e) { if (!/EEXIST|already exists/i.test(String(e))) throw e; }
}

/** List track folders that contain a manifest.json. */
export async function scanLibrary() {
  const fp = FP();
  const out = [];
  let root;
  try { root = await fp.browse("data", ROOT_DIR); }
  catch (e) { return out; } // folder does not exist yet
  for (const rawDir of root.dirs || []) {
    const dir = decodePath(rawDir);
    try {
      const d = await fp.browse("data", dir);
      const manifestPath = (d.files || []).map(decodePath).find(f => f.endsWith("/manifest.json"));
      if (!manifestPath) continue;
      const manifest = await (await fetch(encodeURI(manifestPath), { cache: "no-store" })).json();
      if (manifest.format !== "musslop-loops") continue;
      out.push({ dir, slug: dir.split("/").pop(), name: manifest.track || dir.split("/").pop(), manifest });
    } catch (e) { log.warn("skip", dir, e); }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Fetch a file of a track as ArrayBuffer. */
export async function fetchTrackFile(track, file) {
  const r = await fetch(encodeURI(`${track.dir}/${file}`), { cache: "force-cache" });
  if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`);
  return r.arrayBuffer();
}

/**
 * Import a *_foundry.zip produced by musslop: unpack in the browser (JSZip
 * ships with Foundry) and upload each file to Data/musslop/<slug>/.
 * @param {File|Blob} zipFile
 * @param {(done:number,total:number,name:string)=>void} [onProgress]
 * @returns {{slug:string, dir:string, files:number, manifest:object}}
 */
export async function importZip(zipFile, onProgress) {
  const JSZip = await getJSZip();
  const zip = await JSZip.loadAsync(zipFile);
  const manifestEntry = zip.file("manifest.json");
  if (!manifestEntry) throw new Error("manifest.json not found — is this a musslop export?");
  const manifest = JSON.parse(await manifestEntry.async("string"));
  if (manifest.format !== "musslop-loops") throw new Error("Not a musslop-loops manifest");
  const slug = slugify(manifest.slug || manifest.track || (zipFile.name || "track").replace(/_foundry\.zip$|\.zip$/i, ""));
  const dir = `${ROOT_DIR}/${slug}`;
  await ensureDir(ROOT_DIR);
  await ensureDir(dir);
  const entries = Object.values(zip.files).filter(f => !f.dir);
  const fp = FP();
  let done = 0;
  for (const entry of entries) {
    const name = entry.name.split("/").pop();
    if (!name || name.startsWith(".")) continue;
    const blob = await entry.async("blob");
    const type = name.endsWith(".wav") ? "audio/wav" : name.endsWith(".json") ? "application/json" : "application/octet-stream";
    const file = new File([blob], name, { type });
    // FilePicker.upload reports failure by returning false/undefined, not by throwing
    const res = await fp.upload("data", dir, file, {}, { notify: false });
    if (!res || res.status !== "success") throw new Error(`upload of ${name} failed${res?.message ? ": " + res.message : ""}`);
    done++;
    onProgress?.(done, entries.length, name);
  }
  return { slug, dir, files: done, manifest };
}

// ------------------------------------------------------------------ packs
/**
 * Pack sources are JSON indexes (default: the official one in this repo):
 * { "format": "musslop-packs", "version": 1,
 *   "packs": [{ "id", "name", "description", "tags": [], "license", "credits",
 *               "tracks": [{ "slug", "name", "artist", "zip", "size_mb", "license", "url" }] }] }
 * Each track zip is a regular musslop *_foundry.zip (one track per zip), so a
 * GM can install single tracks and the files stay small.
 */
export const DEFAULT_PACK_INDEX = "https://raw.githubusercontent.com/Siziff/musslop-foundry/main/packs/index.json";

export async function fetchPackIndexes(urls) {
  const out = [];
  for (const url of urls) {
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const idx = await r.json();
      if (idx.format !== "musslop-packs") throw new Error("not a musslop-packs index");
      for (const p of idx.packs || []) out.push({ ...p, source: url });
    } catch (e) { log.warn("pack index failed", url, e); out.push({ id: `err:${url}`, name: url, error: String(e.message || e), tracks: [] }); }
  }
  return out;
}

/** Download a track zip from a pack and import it. */
export async function installPackTrack(track, onProgress) {
  const r = await fetch(track.zip);
  if (!r.ok) throw new Error(`${track.name}: HTTP ${r.status}`);
  const total = +r.headers.get("Content-Length") || 0;
  const reader = r.body.getReader();
  const chunks = []; let got = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    onProgress?.("download", got, total);
  }
  const blob = new Blob(chunks, { type: "application/zip" });
  blob.name = `${track.slug}_foundry.zip`;
  return importZip(blob, (d, n, name) => onProgress?.("upload", d, n, name));
}
