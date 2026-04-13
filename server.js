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
/** Lado máximo em px após conversão (encaixa dentro, sem ampliar). */
const MAX_UPLOAD_DIMENSION = 2048;

/** Serializa uploads por filme para evitar ultrapassar o limite em pedidos paralelos. */
const fotoUploadQueues = new Map();

function serializarUploadFotos(filmeId, fn) {
  const prev = fotoUploadQueues.get(filmeId) || Promise.resolve();
  const result = prev.then(() => fn());
  fotoUploadQueues.set(filmeId, result.catch(() => {}));
  return result;
}

/**
 * Formatos de imagem aceites (PNG e JPEG). Ficheiros temporários usam a extensão indicada;
 * a saída final é sempre JPEG via Sharp.
 */
const ALLOWED_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
};

/** Extensão → MIME canónico (quando o browser envia octet-stream ou MIME vazio). */
const EXT_PARA_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

function normalizarMimeReportado(m) {
  if (!m || typeof m !== 'string') return '';
  const lower = m.toLowerCase().trim();
  if (lower === 'image/x-ms-bmp' || lower === 'image/x-bmp') return 'image/bmp';
  if (lower === 'image/vnd.microsoft.icon') return 'image/x-icon';
  return lower;
}

const MSG_TIPOS_IMAGEM = 'Apenas ficheiros PNG ou JPEG (.png, .jpg, .jpeg).';

/** Resolve MIME aceite para Multer (MIME conhecido ou extensão + octet-stream / vazio). */
function mimeEfetivo(file) {
  const m = normalizarMimeReportado(file.mimetype || '');
  if (ALLOWED_MIME[m]) return m;
  const ext = path.extname(file.originalname || '').toLowerCase();
  const porExt = EXT_PARA_MIME[ext];
  if (porExt && ALLOWED_MIME[porExt] && (!m || m === 'application/octet-stream')) {
    return porExt;
  }
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

/**
 * Resolve o caminho absoluto no disco para uma foto, apenas se estiver dentro de
 * UPLOAD_ROOT/<filmeId>/ (evita path traversal se filmes.json for editado à mão).
 */
function diskPathSeguroParaFoto(filmeId, url) {
  if (!url || typeof url !== 'string') return null;
  const rel = url.replace(/^\/uploads\/filmes\//, '').replace(/\\/g, '/');
  if (!rel || rel.includes('..')) return null;
  const parts = rel.split('/').filter(Boolean);
  if (parts.length < 2 || parts[0] !== filmeId) return null;
  const diskPath = path.join(UPLOAD_ROOT, ...parts);
  const resolved = path.resolve(diskPath);
  const allowedRoot = path.resolve(path.join(UPLOAD_ROOT, filmeId));
  if (resolved === allowedRoot) return null;
  const sep = path.sep;
  if (!resolved.startsWith(allowedRoot + sep)) return null;
  return resolved;
}

/** Converte qualquer imagem aceite para JPEG (navegadores exibem de forma fiável; HEIC/HEIF deixa de depender do cliente). */
async function converterUploadParaJpeg(caminhoOrigem, pastaDestino) {
  const nomeFicheiro = `${crypto.randomUUID()}.jpg`;
  const caminhoDestino = path.join(pastaDestino, nomeFicheiro);
  await sharp(caminhoOrigem)
    .rotate()
    .resize({
      width: MAX_UPLOAD_DIMENSION,
      height: MAX_UPLOAD_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true,
    })
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

app.get('/api/config', (req, res) => {
  res.json({
    maxFotosPerFilme: MAX_FOTOS_PER_FILME,
    maxUploadBytes: MAX_FILE_SIZE,
    maxUploadDimension: MAX_UPLOAD_DIMENSION,
  });
});

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

function tamanhoMaxUploadMb() {
  return Math.round(MAX_FILE_SIZE / (1024 * 1024));
}

app.post('/api/filmes/:id/fotos', (req, res, next) => {
  const filmeId = req.params.id;
  serializarUploadFotos(filmeId, () => processarUploadFoto(req, res))
    .catch(err => next(err));
});

async function processarUploadFoto(req, res) {
  const data = readData();
  const f = data.find(x => x.id === req.params.id);
  if (!f) {
    res.status(404).json({ error: 'Não encontrado' });
    return;
  }
  if ((f.fotos || []).length >= MAX_FOTOS_PER_FILME) {
    res.status(400).json({ error: 'Limite de fotos atingido' });
    return;
  }

  try {
    await new Promise((resolve, reject) => {
      upload.single('foto')(req, res, err => {
        if (err) reject(err);
        else resolve();
      });
    });
  } catch (err) {
    if (err && err.message === 'INVALID_MIME') {
      res.status(400).json({ error: MSG_TIPOS_IMAGEM });
      return;
    }
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      res.status(400).json({ error: `Ficheiro demasiado grande (máx. ${tamanhoMaxUploadMb()} MB)` });
      return;
    }
    res.status(400).json({ error: 'Erro no upload' });
    return;
  }

  if (!req.file) {
    res.status(400).json({ error: 'Nenhum ficheiro enviado' });
    return;
  }
  const mime = mimeEfetivo(req.file);
  if (!mime) {
    try {
      fs.unlinkSync(req.file.path);
    } catch (_) { /* ignore */ }
    res.status(400).json({ error: MSG_TIPOS_IMAGEM });
    return;
  }

  const data2 = readData();
  const idx = data2.findIndex(x => x.id === req.params.id);
  if (idx === -1) {
    try {
      fs.unlinkSync(req.file.path);
    } catch (_) { /* ignore */ }
    res.status(404).json({ error: 'Não encontrado' });
    return;
  }

  if ((data2[idx].fotos || []).length >= MAX_FOTOS_PER_FILME) {
    try {
      fs.unlinkSync(req.file.path);
    } catch (_) { /* ignore */ }
    res.status(400).json({ error: 'Limite de fotos atingido' });
    return;
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
    res.status(400).json({
      error: 'Não foi possível processar a imagem. Verifica que o ficheiro é PNG ou JPEG válido.',
    });
    return;
  }

  try {
    fs.unlinkSync(req.file.path);
  } catch (_) { /* ignore */ }

  const data3 = readData();
  const idx3 = data3.findIndex(x => x.id === req.params.id);
  if (idx3 === -1) {
    try {
      fs.unlinkSync(path.join(pasta, nomeFinal));
    } catch (_) { /* ignore */ }
    res.status(404).json({ error: 'Não encontrado' });
    return;
  }
  if ((data3[idx3].fotos || []).length >= MAX_FOTOS_PER_FILME) {
    try {
      fs.unlinkSync(path.join(pasta, nomeFinal));
    } catch (_) { /* ignore */ }
    res.status(400).json({ error: 'Limite de fotos atingido' });
    return;
  }

  const fotoId = crypto.randomUUID();
  const url = `/uploads/filmes/${req.params.id}/${nomeFinal}`;
  const entry = { id: fotoId, url, createdAt: new Date().toISOString() };
  data3[idx3].fotos = data3[idx3].fotos || [];
  data3[idx3].fotos.unshift(entry);
  writeData(data3);
  res.status(201).json(entry);
}

app.delete('/api/filmes/:id/fotos/:fotoId', (req, res) => {
  const data = readData();
  const idx = data.findIndex(f => f.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Não encontrado' });

  const fotos = data[idx].fotos || [];
  const fi = fotos.findIndex(p => p.id === req.params.fotoId);
  if (fi === -1) return res.status(404).json({ error: 'Foto não encontrada' });

  const [removed] = fotos.splice(fi, 1);
  data[idx].fotos = fotos;

  const diskPath = diskPathSeguroParaFoto(req.params.id, removed.url);
  if (diskPath) {
    try {
      if (fs.existsSync(diskPath)) fs.unlinkSync(diskPath);
    } catch (e) {
      console.warn('Falha ao apagar ficheiro de foto:', diskPath, e && e.message ? e.message : e);
    }
  } else if (removed.url) {
    console.warn('URL de foto inválida ou insegura (ficheiro não removido do disco):', removed.url);
  }

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
