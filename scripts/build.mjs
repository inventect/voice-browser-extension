#!/usr/bin/env node
/**
 * Build the extension into dist/ with esbuild.
 *
 *  - background.js  : ESM bundle (manifest "type": "module")
 *  - content.js     : IIFE bundle (content scripts cannot be ES modules)
 *  - sidepanel.js, options.js, permission.js : IIFE bundles for the extension pages
 *  - manifest.json, *.html, ui.css copied verbatim; icons generated (no image deps)
 *
 *   node scripts/build.mjs [--watch]
 */
import { build, context } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const src = path.join(root, "src");
const dist = path.join(root, "dist");
const watch = process.argv.includes("--watch");

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, "icons"), { recursive: true });

const common = {
  bundle: true,
  minify: false,
  sourcemap: false,
  target: ["chrome116"],
  logLevel: "info",
  legalComments: "none",
};

const jobs = [
  { entryPoints: [path.join(src, "background.js")], outfile: path.join(dist, "background.js"), format: "esm" },
  { entryPoints: [path.join(src, "content.js")], outfile: path.join(dist, "content.js"), format: "iife" },
  { entryPoints: [path.join(src, "sidepanel.js")], outfile: path.join(dist, "sidepanel.js"), format: "iife" },
  { entryPoints: [path.join(src, "options.js")], outfile: path.join(dist, "options.js"), format: "iife" },
  { entryPoints: [path.join(src, "permission.js")], outfile: path.join(dist, "permission.js"), format: "iife" },
  { entryPoints: [path.join(src, "offscreen.js")], outfile: path.join(dist, "offscreen.js"), format: "iife" },
];

function copyStatic() {
  fs.copyFileSync(path.join(root, "manifest.json"), path.join(dist, "manifest.json"));
  for (const f of ["sidepanel.html", "options.html", "permission.html", "offscreen.html", "ui.css", "sidepanel.css", "pages.css", "scribe-worklet.js"]) {
    fs.copyFileSync(path.join(src, f), path.join(dist, f));
  }
  // Icons: rasterised from assets/icon.svg by `npm run icons` (Playwright) into assets/icons/;
  // fall back to a procedural drawing of the same mark if those PNGs are missing.
  for (const size of [16, 32, 48, 128]) {
    const pre = path.join(root, "assets", "icons", `icon${size}.png`);
    fs.writeFileSync(path.join(dist, "icons", `icon${size}.png`), fs.existsSync(pre) ? fs.readFileSync(pre) : makeIcon(size));
  }
}

// ---------------------------------------------------------------------------
// Minimal PNG encoder (RGBA, no deps) for the toolbar icon: amber dot on a dark rounded square.
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** Fallback approximation of assets/icon.svg: amber disc with an ink microphone. */
function makeIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const c = size / 2;
  const R = size / 2 - 1;
  const s = size / 128; // svg units → px
  const inRoundRect = (x, y, rx, ry, w, h, rad) => {
    const dx = Math.max(Math.abs(x - (rx + w / 2)) - (w / 2 - rad), 0);
    const dy = Math.max(Math.abs(y - (ry + h / 2)) - (h / 2 - rad), 0);
    return Math.hypot(dx, dy) <= rad;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const X = x + 0.5;
      const Y = y + 0.5;
      const d = Math.hypot(X - c, Y - c);
      if (d > R) continue;
      const aa = Math.min(1, R - d);
      let [r, g, b] = [230, 135, 30];
      // mic body (rect 52,30 24x44 rx12), cradle arc (center 64,66 r24, y>66), stem + base
      const inBody = inRoundRect(X, Y, 52 * s, 30 * s, 24 * s, 44 * s, 12 * s);
      const arcD = Math.hypot(X - 64 * s, Y - 66 * s);
      const inArc = Y >= 66 * s && Math.abs(arcD - 24 * s) <= 4 * s;
      const inStem = Math.abs(X - 64 * s) <= 4 * s && Y >= 88 * s && Y <= 101 * s;
      const inBase = Math.abs(Y - 101 * s) <= 4 * s && X >= 50 * s && X <= 78 * s;
      if (inBody || inArc || inStem || inBase) [r, g, b] = [28, 24, 20];
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
      px[i + 3] = Math.round(255 * aa);
    }
  }
  const rows = [];
  for (let y = 0; y < size; y++) rows.push(Buffer.concat([Buffer.from([0]), px.subarray(y * size * 4, (y + 1) * size * 4)]));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function main() {
  copyStatic();
  if (watch) {
    const ctxs = await Promise.all(jobs.map((j) => context({ ...common, ...j })));
    await Promise.all(ctxs.map((c) => c.watch()));
    fs.watch(src, (_e, file) => {
      if (/\.(html|css)$/.test(file || "")) copyStatic();
    });
    console.log("watching src/ → dist/ (Ctrl-C to stop)");
  } else {
    await Promise.all(jobs.map((j) => build({ ...common, ...j })));
    const files = fs.readdirSync(dist).filter((f) => fs.statSync(path.join(dist, f)).isFile());
    console.log(`built dist/: ${files.join(", ")} + icons/`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
