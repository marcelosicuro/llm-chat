// server.js — llm-chat
require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const pdfParse = require('pdf-parse');

const app     = express();
const PORT    = process.env.PORT    || 4000;
const LLM_URL = (process.env.LLM_URL || '').replace(/\/$/, '');

if (!LLM_URL) { console.error('❌ LLM_URL não definido no .env'); process.exit(1); }

// ── Persistência (data/conversations.json) ────────────────────
const DATA_DIR  = path.join(__dirname, 'data');
const CONV_FILE = path.join(DATA_DIR, 'conversations.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(CONV_FILE)) fs.writeFileSync(CONV_FILE, '[]');

function load() { return JSON.parse(fs.readFileSync(CONV_FILE, 'utf8')); }
function save(d) { fs.writeFileSync(CONV_FILE, JSON.stringify(d, null, 2)); }

// ── Middlewares ───────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// ── Memória global ───────────────────────────────────────────────
const MEM_FILE = path.join(DATA_DIR, 'memory.md');
if (!fs.existsSync(MEM_FILE)) fs.writeFileSync(MEM_FILE, '');

app.get('/memory', (req, res) => {
  res.json({ text: fs.readFileSync(MEM_FILE, 'utf8') });
});

app.patch('/memory', (req, res) => {
  const text = typeof req.body.text === 'string' ? req.body.text : '';
  fs.writeFileSync(MEM_FILE, text);
  res.json({ ok: true });
});

// ── Conversas ─────────────────────────────────────────────────
// Lista (só metadados, sem messages para não pesar)
app.get('/conversations', (req, res) => {
  const list = load().map(({ id, title, createdAt, updatedAt }) =>
    ({ id, title, createdAt, updatedAt }));
  res.json(list);
});

// Criar
app.post('/conversations', (req, res) => {
  const convs = load();
  const conv  = {
    id:           crypto.randomUUID(),
    title:        'Nova conversa',
    createdAt:    new Date().toISOString(),
    updatedAt:    new Date().toISOString(),
    model:        req.body.model        ?? '',
    temperature:  req.body.temperature  ?? 0.7,
    maxTokens:    req.body.maxTokens    ?? 100000,
    systemPrompt: req.body.systemPrompt ?? '',
    context:      null,   // { name, text }
    messages:     []
  };
  convs.unshift(conv);
  save(convs);
  res.json(conv);
});

// Buscar (com messages)
app.get('/conversations/:id', (req, res) => {
  const conv = load().find(c => c.id === req.params.id);
  if (!conv) return res.status(404).json({ error: 'Não encontrado' });
  res.json(conv);
});

// Atualizar (título, messages, settings, context…)
app.patch('/conversations/:id', (req, res) => {
  const convs = load();
  const idx   = convs.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Não encontrado' });
  Object.assign(convs[idx], req.body, { updatedAt: new Date().toISOString() });
  save(convs);
  res.json(convs[idx]);
});

// Excluir
app.delete('/conversations/:id', (req, res) => {
  save(load().filter(c => c.id !== req.params.id));
  res.json({ ok: true });
});

// ── Upload de contexto ────────────────────────────────────────
const IMAGE_EXTS = /\.(jpg|jpeg|png|gif|webp)$/i;
const IMAGE_MIME = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

app.post('/upload-context', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
  try {
    const isImage = IMAGE_MIME.includes(req.file.mimetype) || IMAGE_EXTS.test(req.file.originalname);
    const isPDF   = req.file.mimetype === 'application/pdf' || req.file.originalname.toLowerCase().endsWith('.pdf');

    if (isImage) {
      const mimeType = req.file.mimetype || 'image/jpeg';
      const base64   = req.file.buffer.toString('base64');
      return res.json({ name: req.file.originalname, size: req.file.size, isImage: true, mimeType, base64 });
    }

    let text;
    if (isPDF) {
      const data = await pdfParse(req.file.buffer);
      text = data.text;
      if (!text.trim()) return res.status(422).json({ error: 'Não foi possível extrair texto do PDF (pode ser escaneado ou protegido).' });
    } else {
      text = req.file.buffer.toString('utf8');
    }
    if (text.length > 24000)
      text = text.slice(0, 24000) + '\n\n[... conteúdo truncado ...]';
    res.json({ name: req.file.originalname, size: req.file.size, text });
  } catch (err) {
    console.error('[upload]', err.message);
    res.status(422).json({ error: 'Não foi possível ler o arquivo.' });
  }
});

// ── Proxy LLM ─────────────────────────────────────────────────
app.all('/llm/*', async (req, res) => {
  const target  = LLM_URL + req.path.replace(/^\/llm/, '');
  const headers = { ...req.headers };
  delete headers['host'];
  delete headers['content-length'];

  const body = ['GET', 'HEAD'].includes(req.method)
    ? undefined : JSON.stringify(req.body);
  if (body) headers['content-length'] = Buffer.byteLength(body).toString();

  try {
    const upstream = await fetch(target, { method: req.method, headers, body });
    res.status(upstream.status);
    const ct = upstream.headers.get('content-type');
    if (ct) res.setHeader('Content-Type', ct);

    if (ct?.includes('text/event-stream')) {
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
      const reader = upstream.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await new Promise((ok, fail) => res.write(value, e => e ? fail(e) : ok()));
        }
      } catch { /* cliente desconectou */ }
      return res.end();
    }

    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.error('[proxy]', err.message);
    res.status(502).json({ error: 'Erro ao contactar o servidor LLM', detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🤖 llm-chat rodando em http://localhost:${PORT}`);
  console.log(`   → LLM: ${LLM_URL}`);
});
