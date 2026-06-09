#!/usr/bin/env node

import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const DEFAULT_URL = "https://rencoder.provid.gg";
const DEFAULT_HOST = "rencoder.provid.gg";

function readEnvFile() {
  try {
    const raw = readFileSync(resolve(root, ".env"), "utf8");
    const match = raw.match(/^BASE_URL=(.+)$/m);
    return match?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

const baseUrl = process.env.BASE_URL ?? readEnvFile() ?? null;

if (!baseUrl) {
  console.log("[inject-domain] BASE_URL not set — skipping injection.");
  process.exit(0);
}

let hostname;
try {
  hostname = new URL(baseUrl).hostname;
  if (!hostname) throw new Error("empty hostname");
} catch {
  console.error(`[inject-domain] Invalid BASE_URL: "${baseUrl}" — must be a full URL, e.g. https://your-domain.com`);
  process.exit(1);
}

const FILES = [
  "public/index.html",
  "public/connect.html",
  "public/encoders/bela/control.html",
  "public/encoders/bela/scripts/install",
  "public/encoders/bela/scripts/uninstall",
  "public/js/home.js",
  "public/encoders/bela/js/control.js",
  "public/encoders/bpos/control.html",
  "public/encoders/bpos/js/control.js",
];

console.log(`[inject-domain] Injecting ${baseUrl} into files...`);

for (const rel of FILES) {
  const file = resolve(root, rel);
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch (e) {
    console.warn(`[inject-domain] Could not read ${rel} — skipping.`);
    continue;
  }

  const patterns = [
    /https:\/\/([a-zA-Z0-9.-]+)\/encoders\/bela\/scripts\/install/,
    /https:\/\/([a-zA-Z0-9.-]+)\/encoders\/bela\/scripts\/uninstall/,
    /<meta property="og:url" content="https:\/\/([^"]+)"/,
    /const DEFAULT_URL = "https:\/\/([^"]+)"/,
    /sed -i "s\|([^|]+)\|remote\.belabox\.net\|g"/,
  ];

  let detectedHost = null;
  for (const p of patterns) {
    const m = p.exec(content);
    if (m) {
      detectedHost = m[1].replaceAll("\\", "");
      break;
    }
  }
  const detectedUrl = detectedHost ? `https://${detectedHost}` : null;

  let updated = content;

  if (detectedUrl && detectedUrl !== baseUrl) {
    updated = updated.replaceAll(detectedUrl, baseUrl);
  }
  if (detectedHost && detectedHost !== hostname) {
    updated = updated.replaceAll(detectedHost, hostname);
    const escapedDetectedHost = detectedHost.replaceAll(".", "\\.");
    const escapedHostname = hostname.replaceAll(".", "\\.");
    updated = updated.replaceAll(escapedDetectedHost, escapedHostname);
  }

  updated = updated.replaceAll(DEFAULT_URL, baseUrl);
  updated = updated.replaceAll(DEFAULT_HOST, hostname);

  const escapedDefaultHost = DEFAULT_HOST.replaceAll(".", "\\.");
  const escapedHostname = hostname.replaceAll(".", "\\.");
  updated = updated.replaceAll(escapedDefaultHost, escapedHostname);

  updated = updated.replaceAll("https://your-domain.com", baseUrl);
  updated = updated.replaceAll("your-domain.com", hostname);
  updated = updated.replaceAll("your-domain\\.com", escapedHostname);

  if (updated !== content) {
    writeFileSync(file, updated);
    console.log(`[inject-domain] Updated ${rel}`);
  } else {
    console.log(`[inject-domain] No changes needed for ${rel}`);
  }
}

console.log(`[inject-domain] Done — domain set to ${baseUrl}`);
