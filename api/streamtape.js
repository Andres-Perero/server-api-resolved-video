export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { url } = req.query;

  if (!url || !url.includes('streamtape.com')) {
    return res.status(400).json({ success: false, error: 'URL de Streamtape inválida' });
  }

  try {
    // Usamos la URL tal como viene (o aseguramos que use el reproductor /e/)
    const targetUrl = url.includes('/e/') ? url : url.replace('/v/', '/e/');

    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://streamtape.com/',
        'Cookie': 'streamtape_session=1;' // Simula sesión activa
      },
    });

    if (response.status === 404) {
      return res.status(404).json({ 
        success: false, 
        error: 'El video no existe o fue eliminado de Streamtape.' 
      });
    }

    if (!response.ok) {
      throw new Error(`Streamtape respondió con HTTP ${response.status}`);
    }

    const html = await response.text();

    // 1. Extraer la ofuscación típica de Streamtape: robotlink + substring
    const robotMatch = html.match(/robotlink['"]\)\.innerHTML\s*=\s*['"]([^'"]+)['"]\s*\+\s*\(['"]([^'"]+)['"]\)/i);

    let finalUrl = '';

    if (robotMatch) {
      const basePart = robotMatch[1];
      const subStringPart = robotMatch[2];
      
      // Recrea el trozo cortado por el .substring(1) o .substring(2) del script
      finalUrl = 'https:' + basePart + subStringPart.substring(1);
    } else {
      // 2. Fallback: buscar directamente por token / get_video
      const fallback = html.match(/(?:https?:)?\/\/streamtape\.com\/get_video\?[^"'>\s]+/i);
      if (fallback) finalUrl = fallback[0];
    }

    if (!finalUrl) {
      return res.status(404).json({ 
        success: false, 
        error: 'No se pudo desofuscar la URL del video.' 
      });
    }

    // Normalizar URL
    finalUrl = finalUrl.replace(/&amp;/g, '&');
    if (finalUrl.startsWith('//')) finalUrl = 'https:' + finalUrl;
    if (!finalUrl.startsWith('http')) finalUrl = 'https://' + finalUrl;

    return res.status(200).json({
      success: true,
      url: finalUrl
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}