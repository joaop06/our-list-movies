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
