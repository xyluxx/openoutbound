#!/usr/bin/env node
// Renders the brand images in assets/ from the HTML sources in assets/src/ with a local
// Chrome or Chromium in headless mode. The sources load Geist from Google Fonts, so the
// machine needs network access while rendering.
//
//   node scripts/render-brand.mjs                 # every image
//   node scripts/render-brand.mjs banner social   # only these sources
//   CHROME_PATH=/path/to/chrome node scripts/render-brand.mjs
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const src = resolve(root, "assets/src");
const out = resolve(root, "assets");

/**
 * Every image: source page, theme, CSS size and pixel density. `bg: "github"` paints the page in
 * GitHub's dark background so README images have no visible edge there; `transparent` keeps the
 * page background see-through.
 */
const JOBS = [
  { source: "banner", theme: "dark", bg: "github", file: "banner-dark.png", size: [1280, 720, 2] },
  { source: "banner", theme: "light", file: "banner-light.png", size: [1280, 720, 2] },
  {
    source: "how-it-works",
    theme: "dark",
    bg: "github",
    file: "how-it-works-dark.png",
    size: [1280, 624, 2],
  },
  { source: "how-it-works", theme: "light", file: "how-it-works-light.png", size: [1280, 624, 2] },
  { source: "social", theme: "dark", file: "social-preview.png", size: [1280, 640, 1] },
  {
    source: "wordmark",
    theme: "dark",
    file: "wordmark-dark.png",
    size: [480, 120, 2],
    transparent: true,
  },
  {
    source: "wordmark",
    theme: "light",
    file: "wordmark-light.png",
    size: [480, 120, 2],
    transparent: true,
  },
];

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  const found = candidates.find((path) => path && existsSync(path));
  if (!found) {
    console.error("No Chrome or Chromium found. Set CHROME_PATH to the browser binary.");
    process.exit(1);
  }
  return found;
}

const filters = process.argv.slice(2);
const jobs = JOBS.filter((job) => filters.length === 0 || filters.includes(job.source));
if (jobs.length === 0) {
  console.error(
    `Nothing to render. Sources: ${[...new Set(JOBS.map((job) => job.source))].join(", ")}`,
  );
  process.exit(1);
}

const chrome = findChrome();
const profile = mkdtempSync(join(tmpdir(), "openoutbound-brand-"));
let failed = 0;
try {
  for (const job of jobs) {
    const [width, height, scale] = job.size;
    const page = pathToFileURL(join(src, `${job.source}.html`));
    page.search = `?theme=${job.theme}${job.bg ? `&bg=${job.bg}` : ""}`;
    const target = join(out, job.file);
    rmSync(target, { force: true });
    execFileSync(
      chrome,
      [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${profile}`,
        "--virtual-time-budget=8000",
        `--force-device-scale-factor=${scale}`,
        `--window-size=${width},${height}`,
        ...(job.transparent ? ["--default-background-color=00000000"] : []),
        `--screenshot=${target}`,
        page.href,
      ],
      { stdio: "ignore", timeout: 120_000 },
    );
    if (!existsSync(target)) {
      console.error(`FAILED  ${job.file}`);
      failed += 1;
      continue;
    }
    const size = Math.round(statSync(target).size / 1024);
    console.log(`ok  ${job.file}  ${width * scale} x ${height * scale}  ${size} KB`);
  }
} finally {
  rmSync(profile, { recursive: true, force: true });
}
process.exit(failed > 0 ? 1 : 0);
