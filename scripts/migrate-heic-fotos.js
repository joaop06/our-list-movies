#!/usr/bin/env node
/**
 * Converte fotos já guardadas como .heic/.heif para JPEG e atualiza urls em filmes.json.
 * Uso: node scripts/migrate-heic-fotos.js
 * (respeita DATA_FILE no .env, como o servidor)
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

const root = path.join(__dirname, '..');
const DATA_FILE = path.join(root, process.env.DATA_FILE || 'data/filmes.json');
const PUBLIC_UPLOADS = path.join(root, 'public', 'uploads', 'filmes');

async function converterParaJpeg(caminhoOrigem, caminhoDestino) {
  await sharp(caminhoOrigem)
    .rotate()
    .jpeg({ quality: 88, mozjpeg: true })
    .toFile(caminhoDestino);
}

async function main() {
  if (!fs.existsSync(DATA_FILE)) {
    console.log('Ficheiro de dados inexistente:', DATA_FILE);
    process.exit(0);
  }

  const raw = fs.readFileSync(DATA_FILE, 'utf-8');
  const data = JSON.parse(raw);
  let changed = false;

  for (const filme of data) {
    if (!filme.fotos || !Array.isArray(filme.fotos)) continue;

    for (const foto of filme.fotos) {
      const url = foto.url || '';
      if (!/\.(heic|heif)$/i.test(url)) continue;

      const rel = url.replace(/^\/uploads\/filmes\//, '');
      const inPath = path.join(PUBLIC_UPLOADS, rel);

      if (!fs.existsSync(inPath)) {
        console.warn('Ficheiro em falta (mantém entrada no JSON):', inPath);
        continue;
      }

      const dir = path.dirname(inPath);
      const outName = `${crypto.randomUUID()}.jpg`;
      const outPath = path.join(dir, outName);

      try {
        await converterParaJpeg(inPath, outPath);
      } catch (err) {
        console.error('Falha ao converter', inPath, err.message || err);
        continue;
      }

      try {
        fs.unlinkSync(inPath);
      } catch (_) { /* ignore */ }

      foto.url = `/uploads/filmes/${filme.id}/${outName}`;
      changed = true;
      console.log('Migrado:', url, '->', foto.url);
    }
  }

  if (changed) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    console.log('Concluído: filmes.json atualizado.');
  } else {
    console.log('Nenhuma foto .heic/.heif encontrada; nada a fazer.');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
