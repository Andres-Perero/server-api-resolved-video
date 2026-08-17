import express from 'express';

// Importa directamente las funciones Serverless
import healthHandler from './api/health.js';
import streamtapeHandler from './api/streamtape.js';
import resolveHandler from './api/resolve.js';
import proxyHandler from './api/proxy.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Rutas explícitas de la carpeta /api
app.all('/api/health', (req, res) => healthHandler(req, res));
app.all('/api/streamtape', (req, res) => streamtapeHandler(req, res));
app.all('/api/resolve', (req, res) => resolveHandler(req, res));
app.all('/api/proxy', (req, res) => proxyHandler(req, res));

// Captura el resto de rutas y las envía a health.js
app.all('*', (req, res) => healthHandler(req, res));

app.listen(PORT, () => {
  console.log(`Servidor local corriendo en http://localhost:${PORT}`);
});