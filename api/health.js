export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  
  res.status(200).json({
    status: "ok",
    timestamp: new Date().toISOString(),
    endpoints: [
      "/api/health",
      "/api/streamtape?url=",
      "/api/resolve?url=",
      "/api/proxy?url="
    ]
  });
}