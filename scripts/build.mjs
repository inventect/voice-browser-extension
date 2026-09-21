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
];

function copyStatic() {
  fs.copyFileSync(path.join(root, "manifest.json"), path.join(dist, "manifest.json"));
  for (const f of ["sidepanel.html", "options.html", "permission.html", "ui.css"]) {
    fs.copyFileSync(path.join(src, f), path.join(dist, f));
  }
  for (const size of [16, 32, 48, 128]) fs.writeFileSync(path.join(dist, "icons", `icon${size}.png`), makeIcon(size));
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
function makeIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const r = size / 2;
  const radius = size * 0.22; // rounded corners
  const dotR = size * 0.26;
  const micTop = size * 0.28;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // rounded square background
      const dx = Math.max(Math.abs(x + 0.5 - r) - (r - radius), 0);
      const dy = Math.max(Math.abs(y + 0.5 - r) - (r - radius), 0);
      const inside = Math.hypot(dx, dy) <= radius;
      if (!inside) continue;
      let [R, G, B] = [17, 24, 39]; // #111827
      // amber dot (the "●" from the control page)
      const d = Math.hypot(x + 0.5 - r, y + 0.5 - r * 0.95);
      if (d <= dotR) [R, G, B] = [245, 158, 11];
      else if (d <= dotR + 1) {
        const a = dotR + 1 - d;
        R = Math.round(R * (1 - a) + 245 * a);
        G = Math.round(G * (1 - a) + 158 * a);
        B = Math.round(B * (1 - a) + 11 * a);
      }
      // small "stand" under the dot so it reads as a mic at 16px
      if (y > r * 0.95 + dotR && y < size * 0.82 && Math.abs(x + 0.5 - r) < size * 0.06) [R, G, B] = [245, 158, 11];
      if (y >= size * 0.78 && y < size * 0.84 && Math.abs(x + 0.5 - r) < size * 0.2) [R, G, B] = [245, 158, 11];
      px[i] = R;
      px[i + 1] = G;
      px[i + 2] = B;
      px[i + 3] = 255;
    }
  }
  void micTop;
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
