require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, process.env.DATA_FILE || 'data/filmes.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function readData() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify([], null, 2));
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

app.get('/api/filmes', (req, res) => {
  res.json(readData());
});

app.get('/api/search', async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2) return res.json([]);
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) return res.json([]);

  try {
    const query = encodeURIComponent(q.trim());
    const [moviesRes, tvRes] = await Promise.all([
      fetch(`https://api.themoviedb.org/3/search/movie?api_key=${apiKey}&query=${query}&language=pt-BR`),
      fetch(`https://api.themoviedb.org/3/search/tv?api_key=${apiKey}&query=${query}&language=pt-BR`),
    ]);
    const movies = await moviesRes.json();
    const tv = await tvRes.json();

    const results = [
      ...(movies.results || []).slice(0, 5).map(m => ({
        tmdb_id: m.id,
        titulo: m.title,
        tipo: 'filme',
        ano: m.release_date ? m.release_date.slice(0, 4) : '',
        poster_path: m.poster_path || null,
        backdrop_path: m.backdrop_path || null,
      })),
      ...(tv.results || []).slice(0, 5).map(t => ({
        tmdb_id: t.id,
        titulo: t.name,
        tipo: 'serie',
        ano: t.first_air_date ? t.first_air_date.slice(0, 4) : '',
        poster_path: t.poster_path || null,
        backdrop_path: t.backdrop_path || null,
      })),
    ];
    res.json(results);
  } catch {
    res.json([]);
  }
});

app.post('/api/filmes', (req, res) => {
  const data = readData();
  const novo = {
    id: Date.now().toString(),
    titulo: req.body.titulo,
    tipo: req.body.tipo || 'filme',
    nota: req.body.nota || '',
    assistido: false,
    adicionadoEm: new Date().toISOString(),
    assistidoEm: null,
    previsaoEm: req.body.previsaoEm || null,
    tmdb_id: req.body.tmdb_id || null,
    poster_path: req.body.poster_path || null,
    backdrop_path: req.body.backdrop_path || null,
  };
  data.unshift(novo);
  writeData(data);
  res.status(201).json(novo);
});

app.patch('/api/filmes/:id', (req, res) => {
  const data = readData();
  const idx = data.findIndex(f => f.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Não encontrado' });
  data[idx] = { ...data[idx], ...req.body };
  if (req.body.assistido === true && !data[idx].assistidoEm) {
    data[idx].assistidoEm = new Date().toISOString();
  }
  if (req.body.assistido === false) {
    data[idx].assistidoEm = null;
  }
  writeData(data);
  res.json(data[idx]);
});

app.put('/api/filmes/reorder', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids deve ser um array' });
  const data = readData();
  const map = new Map(data.map(f => [f.id, f]));
  const reordered = ids.map(id => map.get(id)).filter(Boolean);
  // Append any items not included in ids (safety)
  const idsSet = new Set(ids);
  data.filter(f => !idsSet.has(f.id)).forEach(f => reordered.push(f));
  writeData(reordered);
  res.json(reordered);
});

app.delete('/api/filmes/:id', (req, res) => {
  const data = readData();
  const idx = data.findIndex(f => f.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Não encontrado' });
  data.splice(idx, 1);
  writeData(data);
  res.status(204).end();
});

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
