import express from 'express';
import cors from 'cors';
import { chromium } from 'playwright';
import { resolveVimeosEmbed } from './api/vimeos.js'; // Ajusta la ruta a tu resolvedor

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Reutilizamos la instancia del navegador para mayor velocidad
let browser;

app.get('/api/resolve', async (req, res) => {
  const embedUrl = req.query.url;

  if (!embedUrl) {
    return res.status(400).json({ error: 'Parámetro "url" requerido' });
  }

  try {
    if (!browser) {
      browser = await chromium.launch({ headless: true });
    }

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'es-ES'
    });

    const result = await resolveVimeosEmbed(context, embedUrl);

    if (result && result.url) {
      return res.json(result);
    } else {
      return res.status(404).json({ error: 'No se pudo resolver el .m3u8' });
    }
  } catch (error) {
    console.error('Error al resolver:', error);
    return res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor de resolución corriendo en puerto ${PORT}`);
});