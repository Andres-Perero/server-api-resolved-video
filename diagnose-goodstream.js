/**
 * diagnose-goodstream.js — Diagnóstico para embeds de Goodstream
 */

import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const targetUrl = process.argv[2] || 'https://goodstream.one/embed-810ef948gg9q.html';

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();
  log(`Analizando: ${targetUrl}`);

  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  const html = await page.content();

  // 1. Detección vía Regex sobre HTML crudo
  const m3u8Match = html.match(/file\s*:\s*["']([^"']+\.m3u8[^"']*)["']/i);
  log(`[Regex] Master M3U8: ${m3u8Match ? m3u8Match[1] : 'No encontrado'}`);

  const vttMatches = [...html.matchAll(/file\s*:\s*["']([^"']+\.vtt)["']/gi)];
  log(`[Regex] Subtítulos VTT detectados: ${vttMatches.length}`);
  vttMatches.forEach(m => log(`  ↳ Subtítulo: ${m[1]}`));

  // 2. Extraer datos del DOM tras carga de scripts
  await page.waitForTimeout(3000); // Esperar que Cloudflare Rocket Loader instancie objetos
  
  const jwInfo = await page.evaluate(() => {
    if (typeof jwplayer !== 'function') return { status: 'jwplayer no definido' };
    const player = jwplayer('vplayer');
    if (!player || !player.getConfig) return { status: 'instancia vplayer no hallada' };
    
    return {
      playlist: player.getPlaylist?.(),
      captions: player.getCaptionsList?.(),
      audioTracks: player.getAudioTracks?.()
    };
  });

  log(`[JWPlayer API]: ${JSON.stringify(jwInfo, null, 2)}`);

  writeFileSync(join(__dirname, 'goodstream-report.json'), JSON.stringify({
    targetUrl,
    extractedM3u8: m3u8Match?.[1] || null,
    jwInfo
  }, null, 2));

  await browser.close();
}

main().catch(console.error);