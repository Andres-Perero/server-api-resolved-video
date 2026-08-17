// /api/resolve.js
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const embedUrl = req.query.url || req.query.embedUrl;

  if (!embedUrl) {
    return res.status(400).json({ error: 'Parámetro "url" o "embedUrl" requerido' });
  }

  try {
    // ─── Streamtape ───────────────────────────────────────
    if (embedUrl.includes("streamtape.com")) {
      return res.redirect(307, `/api/streamtape?url=${encodeURIComponent(embedUrl)}`);
    }

    // ─── Streamwish / HLSWish / StreamHG ──────────────────
    if (
      embedUrl.includes("streamwish") ||
      embedUrl.includes("hlswish") ||
      embedUrl.includes("streamhg") ||
      embedUrl.includes("streamwish.to") ||
      embedUrl.includes("awish.pro") ||
      embedUrl.includes("strwish.com")
    ) {
      const result = await resolveStreamwish(embedUrl);
      if (!result) {
        return res.status(404).json({ error: "No se pudo resolver el stream" });
      }
      return res.json(result);
    }

    return res.status(400).json({ error: "Servidor no soportado" });

  } catch (error) {
    console.error("[RESOLVE ERROR]", error.message);
    return res.status(500).json({ error: error.message });
  }
}

// ─────────────────────────────────────────────────────────────
// Resolver Streamwish / HLSWish (solo fetch)
// ─────────────────────────────────────────────────────────────
async function resolveStreamwish(embedUrl) {
  const response = await fetch(embedUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
      "Referer": "https://google.com/",
    },
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const html = await response.text();

  // Buscamos el m3u8 de varias formas
  const patterns = [
    // sources: [{file:"...m3u8"}]
    /file\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i,
    
    // "hls2": "https://...m3u8"
    /["']hls[234]?["']\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i,
    
    // sources = "https://...m3u8"
    /sources\s*=\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i,
    
    // Cualquier .m3u8 que parezca de streamwish
    /(https?:\/\/[^"'\\s<>]+(?:streamwish|hlswish|streamhg|cdn)[^"'\\s<>]*\.m3u8[^"'\\s<>]*)/i,
    
    // packed eval (último recurso - muy básico)
    /eval\(function\(p,a,c,k,e,d\)[\s\S]*?\.m3u8[\s\S]*?\)/i
  ];

  let m3u8 = null;

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1] && match[1].includes(".m3u8")) {
      m3u8 = match[1];
      break;
    }
  }

  // Si encontramos algo dentro de un eval packed, intentamos sacarlo
  if (!m3u8) {
    const packedMatch = html.match(/eval\(function\(p,a,c,k,e,d\){[\s\S]+?}\('([\s\S]+?)'\.split/);
    if (packedMatch) {
      // Búsqueda simple de m3u8 dentro del packed
      const innerMatch = packedMatch[0].match(/(https?:\\\/\\\/[^"'\\]+?\.m3u8[^"'\\]*)/i);
      if (innerMatch) {
        m3u8 = innerMatch[1].replace(/\\+/g, "");
      }
    }
  }

  if (!m3u8) {
    return null;
  }

  // Limpieza
  m3u8 = m3u8.replace(/\\+/g, "").replace(/&amp;/g, "&");

  const parsed = new URL(embedUrl);

  return {
    success: true,
    type: "hls",
    url: m3u8,
    serverName: "streamwish",
    referer: `${parsed.protocol}//${parsed.host}/`,
    resolvedAt: new Date().toISOString()
  };
}