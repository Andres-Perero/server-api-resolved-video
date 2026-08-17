// /api/streamtape.js
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const url = req.query.url;

  if (!url || !url.includes("streamtape.com")) {
    return res.status(400).json({
      success: false,
      error: "URL de Streamtape inválida"
    });
  }

  try {
    // Probamos tanto /e/ como /v/
    const urlsToTry = [
      url.replace("/e/", "/v/"),
      url,
      url.replace("/v/", "/e/")
    ];

    let html = null;
    let lastError = null;

    for (const targetUrl of urlsToTry) {
      try {
        const response = await fetch(targetUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
            "Referer": "https://streamtape.com/",
            "Origin": "https://streamtape.com"
          },
          redirect: "follow"
        });

        if (response.ok) {
          html = await response.text();
          break;
        }
      } catch (err) {
        lastError = err.message;
      }
    }

    if (!html) {
      throw new Error(lastError || "No se pudo obtener el HTML");
    }

    // Varios métodos de extracción (ordenados por fiabilidad)
    const patterns = [
      // 1. src directo del video
      /id=["']mainvideo["'][^>]*src=["']([^"']+)["']/i,
      
      // 2. botlink / robotlink / norobotlink / ideoolink
      /getElementById\(['"](?:botlink|robotlink|norobotlink|ideoolink)['"]\)\.innerHTML\s*=\s*['"]([^'"]+)['"]/i,
      
      // 3. Cualquier get_video
      /(https?:)?\/\/streamtape\.com\/get_video\?[^"'\\s<>]+/i,
      
      // 4. token + expires (último recurso)
      /get_video\?id=([^&"']+)&expires=([^&"']+)&ip=([^&"']+)&token=([^&"']+)/i
    ];

    let finalUrl = null;

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match) {
        if (match[1] && match[1].includes("get_video")) {
          finalUrl = match[1];
          break;
        }
        // Caso del patrón 4 (reconstruir)
        if (match[1] && match[2] && match[3] && match[4]) {
          finalUrl = `//streamtape.com/get_video?id=${match[1]}&expires=${match[2]}&ip=${match[3]}&token=${match[4]}`;
          break;
        }
        if (match[1]) {
          finalUrl = match[1];
          break;
        }
      }
    }

    if (!finalUrl) {
      return res.status(404).json({
        success: false,
        error: "No se pudo extraer el link del video"
      });
    }

    // Limpieza final
    finalUrl = finalUrl.replace(/&amp;/g, "&").replace(/\\/g, "");
    if (finalUrl.startsWith("//")) finalUrl = "https:" + finalUrl;
    if (!finalUrl.startsWith("http")) finalUrl = "https://" + finalUrl;

    if (!finalUrl.includes("stream=1")) {
      finalUrl += (finalUrl.includes("?") ? "&" : "?") + "stream=1";
    }

    return res.status(200).json({
      success: true,
      type: "mp4",
      url: finalUrl,
      serverName: "streamtape",
      resolvedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error("[STREAMTAPE ERROR]", error.message);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}