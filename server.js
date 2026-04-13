require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const sharp = require('sharp');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, process.env.DATA_FILE || 'data/filmes.json');

const UPLOAD_ROOT = path.join(__dirname, 'public', 'uploads', 'filmes');
const MAX_FILE_SIZE = 8 * 1024 * 1024;
const MAX_FOTOS_PER_FILME = 40;

const ALLOWED_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif',
};

/** Resolve MIME aceite para Multer (inclui .heic/.heif com octet-stream ou MIME vazio). */
function mimeEfetivo(file) {
  const m = file.mimetype || '';
  if (ALLOWED_MIME[m]) return m;
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (ext === '.heic' && (!m || m === 'application/octet-stream')) return 'image/heic';
  if (ext === '.heif' && (!m || m === 'application/octet-stream')) return 'image/heif';
  return null;
}

function normalizeFilme(f) {
  if (!f.fotos || !Array.isArray(f.fotos)) f.fotos = [];
  return f;
}

function readData() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify([], null, 2));
  }
  const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  return raw.map(f => normalizeFilme({ ...f }));
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function ensureUploadDir(filmeId) {
  const dir = path.join(UPLOAD_ROOT, filmeId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function removeUploadDir(filmeId) {
  const dir = path.join(UPLOAD_ROOT, filmeId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Converte qualquer imagem aceite para JPEG (navegadores exibem de forma fiável; HEIC/HEIF deixa de depender do cliente). */
async function converterUploadParaJpeg(caminhoOrigem, pastaDestino) {
  const nomeFicheiro = `${crypto.randomUUID()}.jpg`;
  const caminhoDestino = path.join(pastaDestino, nomeFicheiro);
  await sharp(caminhoOrigem)
    .rotate()
    .jpeg({ quality: 88, mozjpeg: true })
    .toFile(caminhoDestino);
  return { nomeFicheiro, caminhoDestino };
}

const storage = multer.diskStorage({
  destination(req, file, cb) {
    try {
      const dir = ensureUploadDir(req.params.id);
      cb(null, dir);
    } catch (e) {
      cb(e);
    }
  },
  filename(req, file, cb) {
    const mime = mimeEfetivo(file);
    const ext = mime ? ALLOWED_MIME[mime] : '.bin';
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter(req, file, cb) {
    if (mimeEfetivo(file)) cb(null, true);
    else cb(new Error('INVALID_MIME'));
  },
});

app.use(express.json());

app.get('/api/filmes', (req, res) => {
  res.json(readData());
});

app.get('/api/filmes/:id', (req, res) => {
  const data = readData();
  const f = data.find(x => x.id === req.params.id);
  if (!f) return res.status(404).json({ error: 'Não encontrado' });
  res.json(f);
});

function stripImmutableFromPatch(body) {
  const b = { ...body };
  delete b.fotos;
  delete b.id;
  delete b.adicionadoEm;
  return b;
}

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
    fotos: [],
  };
  data.unshift(novo);
  writeData(data);
  res.status(201).json(novo);
});

app.patch('/api/filmes/:id', (req, res) => {
  const data = readData();
  const idx = data.findIndex(f => f.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Não encontrado' });
  const body = stripImmutableFromPatch(req.body);
  data[idx] = { ...data[idx], ...body };
  if (req.body.assistido === true && !data[idx].assistidoEm) {
    data[idx].assistidoEm = new Date().toISOString();
  }
  if (req.body.assistido === false) {
    data[idx].assistidoEm = null;
  }
  writeData(data);
  res.json(data[idx]);
});

app.post(
  '/api/filmes/:id/fotos',
  (req, res, next) => {
    const data = readData();
    const f = data.find(x => x.id === req.params.id);
    if (!f) return res.status(404).json({ error: 'Não encontrado' });
    if ((f.fotos || []).length >= MAX_FOTOS_PER_FILME) {
      return res.status(400).json({ error: 'Limite de fotos atingido' });
    }
    next();
  },
  (req, res, next) => {
    upload.single('foto')(req, res, err => {
      if (!err) return next();
      if (err.message === 'INVALID_MIME') {
        return res.status(400).json({ error: 'Tipo de ficheiro não permitido (JPEG, PNG, WebP, HEIC ou HEIF)' });
      }
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Ficheiro demasiado grande (máx. 8 MB)' });
      }
      return res.status(400).json({ error: 'Erro no upload' });
    });
  },
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Nenhum ficheiro enviado' });
    const mime = mimeEfetivo(req.file);
    if (!mime) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (_) { /* ignore */ }
      return res.status(400).json({ error: 'Tipo de ficheiro não permitido' });
    }

    const data = readData();
    const idx = data.findIndex(x => x.id === req.params.id);
    if (idx === -1) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (_) { /* ignore */ }
      return res.status(404).json({ error: 'Não encontrado' });
    }

    const pasta = path.dirname(req.file.path);
    let nomeFinal;
    try {
      const { nomeFicheiro } = await converterUploadParaJpeg(req.file.path, pasta);
      nomeFinal = nomeFicheiro;
    } catch (err) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (_) { /* ignore */ }
      console.error('Erro ao converter foto:', err);
      return res.status(400).json({
        error: 'Não foi possível processar a imagem. Se for HEIC/HEIF, o servidor pode precisar de bibliotecas libheif (Linux) ou tenta enviar JPEG.',
      });
    }

    try {
      fs.unlinkSync(req.file.path);
    } catch (_) { /* ignore */ }

    const fotoId = crypto.randomUUID();
    const url = `/uploads/filmes/${req.params.id}/${nomeFinal}`;
    const entry = { id: fotoId, url, createdAt: new Date().toISOString() };
    data[idx].fotos = data[idx].fotos || [];
    data[idx].fotos.unshift(entry);
    writeData(data);
    res.status(201).json(entry);
  },
);

app.delete('/api/filmes/:id/fotos/:fotoId', (req, res) => {
  const data = readData();
  const idx = data.findIndex(f => f.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Não encontrado' });

  const fotos = data[idx].fotos || [];
  const fi = fotos.findIndex(p => p.id === req.params.fotoId);
  if (fi === -1) return res.status(404).json({ error: 'Foto não encontrada' });

  const [removed] = fotos.splice(fi, 1);
  data[idx].fotos = fotos;

  const rel = removed.url.replace(/^\/uploads\/filmes\//, '');
  const diskPath = path.join(__dirname, 'public', 'uploads', 'filmes', rel);
  try {
    if (fs.existsSync(diskPath)) fs.unlinkSync(diskPath);
  } catch (_) { /* ignore */ }

  writeData(data);
  res.status(204).end();
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

app.put('/api/filmes/reorder', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids deve ser um array' });
  const data = readData();
  const map = new Map(data.map(f => [f.id, f]));
  const reordered = ids.map(id => map.get(id)).filter(Boolean);
  const idsSet = new Set(ids);
  data.filter(f => !idsSet.has(f.id)).forEach(f => reordered.push(f));
  writeData(reordered);
  res.json(reordered);
});

app.delete('/api/filmes/:id', (req, res) => {
  const data = readData();
  const idx = data.findIndex(f => f.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Não encontrado' });
  if (data[idx].assistido) {
    return res.status(403).json({ error: 'Não é possível remover filmes já assistidos' });
  }
  data.splice(idx, 1);
  writeData(data);
  removeUploadDir(req.params.id);
  res.status(204).end();
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
