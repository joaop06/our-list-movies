#!/usr/bin/env node
/**
 * Adiciona `status` a cada filme a partir de `assistido` e remove `assistido`.
 * Uso: node scripts/migrate-status.js
 * (respeita DATA_FILE no .env, como o servidor)
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const DATA_FILE = path.join(root, process.env.DATA_FILE || 'data/filmes.json');

function main() {
  if (!fs.existsSync(DATA_FILE)) {
    console.error('Ficheiro não encontrado:', DATA_FILE);
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  if (!Array.isArray(raw)) {
    console.error('Formato inválido: esperado array.');
    process.exit(1);
  }
  let n = 0;
  for (const f of raw) {
    if (!Object.prototype.hasOwnProperty.call(f, 'status')) {
      f.status = f.assistido === true ? 'assistido' : 'nao_assistido';
      delete f.assistido;
      n += 1;
    }
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(raw, null, 2));
  console.log(`Migrados ${n} item(ns). Ficheiro: ${DATA_FILE}`);
}

main();
