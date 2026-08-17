export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") return res.status(200).end();

  const targetUrl = req.query.url;
  const referer = req.query.referer || "https://streamtape.com/";

  if (!targetUrl) {
    return res.status(400).json({ error: 'Parámetro "url" requerido' });
  }

  try {
    const response = await fetch(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": referer,
        "Origin": new URL(referer).origin,
        "Accept": "*/*"
      }
    });

    if (!response.ok) {
      return res.status(response.status).send(`Upstream error: ${response.status}`);
    }

    const contentType = response.headers.get("content-type") || "application/octet-stream";
    const buffer = Buffer.from(await response.arrayBuffer());

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", buffer.length);
    res.send(buffer);

  } catch (err) {
    console.error("[PROXY ERROR]", err.message);
    res.status(502).json({ error: "Proxy failed", message: err.message });
  }
}