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

    let getVideoUrl = '';

    // Captura: document.getElementById('botlink').innerHTML = '//streamtape.com/get_video?id=a' + ('xyzajVG...').substring(4);
    const botlinkMatch = html.match(/getElementById\(['"]botlink['"]\)\.innerHTML\s*=\s*['"]([^'"]+)['"]\s*\+\s*\(['"]([^'"]+)['"]\)\.substring\((\d+)\)/i);

    if (botlinkMatch) {
      const basePart = botlinkMatch[1];      // '//streamtape.com/get_video?id=a'
      const rawString = botlinkMatch[2];     // 'xyzajVG33x0JYhxvj2&expires=...'
      const subLength = parseInt(botlinkMatch[3], 10); // 4

      getVideoUrl = 'https:' + basePart + rawString.substring(subLength);
    } else {
      // Fallback para robotlink en caso de variante con múltiples substrings
      const robotMatch = html.match(/getElementById\(['"]robotlink['"]\)\.innerHTML\s*=\s*['"]([^'"]+)['"]\s*\+\s*\(['"]([^'"]+)['"]\)\.substring\((\d+)\)\.substring\((\d+)\)/i);
      
      if (robotMatch) {
        const basePart = robotMatch[1];
        const rawString = robotMatch[2];
        const sub1 = parseInt(robotMatch[3], 10);
        const sub2 = parseInt(robotMatch[4], 10);

        getVideoUrl = 'https:' + basePart + rawString.substring(sub1).substring(sub2);
      }
    }

    if (!getVideoUrl) {
      return res.status(404).json({ success: false, error: 'No se pudo desofuscar la URL de Streamtape' });
    }

    getVideoUrl = getVideoUrl.replace(/&amp;/g, '&');
    if (!getVideoUrl.includes('stream=1')) {
      getVideoUrl += '&stream=1';
    }

    // PASO FINAL: Obtener el enlace directo al CDN tapecontent.net
    const redirectResponse = await fetch(getVideoUrl, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': 'https://streamtape.com/'
      }
    });

    const finalCdnUrl = redirectResponse.headers.get('location') || redirectResponse.url;

    return res.status(200).json({
      success: true,
      get_video: getVideoUrl,
      url: finalCdnUrl
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}