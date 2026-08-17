export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { url } = req.query;

  if (!url || !url.includes('streamtape.com')) {
    return res.status(400).json({ success: false, error: 'URL de Streamtape inválida' });
  }

  try {
    const targetUrl = url.includes('/e/') ? url : url.replace('/v/', '/e/');

    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': 'https://streamtape.com/',
        'Cookie': 'streamtape_session=1;'
      },
    });

    if (response.status === 404) {
      return res.status(404).json({ success: false, error: 'El video no existe en Streamtape' });
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();

    // Extraer token y enlace ofuscado
    const robotMatch = html.match(/robotlink['"]\)\.innerHTML\s*=\s*['"]([^'"]+)['"]\s*\+\s*\(['"]([^'"]+)['"]\)/i);

    let getVideoUrl = '';

    if (robotMatch) {
      const basePart = robotMatch[1];
      const subStringPart = robotMatch[2];
      getVideoUrl = 'https:' + basePart + subStringPart.substring(1);
    } else {
      const fallback = html.match(/(?:https?:)?\/\/streamtape\.com\/get_video\?[^"'>\s]+/i);
      if (fallback) getVideoUrl = fallback[0];
    }

    if (!getVideoUrl) {
      return res.status(404).json({ success: false, error: 'No se pudo desofuscar la URL de Streamtape' });
    }

    getVideoUrl = getVideoUrl.replace(/&amp;/g, '&');
    if (getVideoUrl.startsWith('//')) getVideoUrl = 'https:' + getVideoUrl;

    // SEGUNDO PASO: Hacer un fetch con redirect 'manual' para atrapar la URL del CDN (tapecontent.net)
    const redirectResponse = await fetch(getVideoUrl, {
      method: 'GET',
      redirect: 'manual', // Evita descargar el MP4 completo, solo atrapa el Location
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': 'https://streamtape.com/'
      }
    });

    // Extraer el Location del CDN de las cabeceras
    const finalCdnUrl = redirectResponse.headers.get('location') || redirectResponse.url;

    return res.status(200).json({
      success: true,
      get_video: getVideoUrl,
      url: finalCdnUrl // <-- Aquí obtendrás la URL directa a tapecontent.net
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}