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
    maxTokens:    req.body.maxTokens    ?? 4096,
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

// ── Geração de imagem (ComfyUI) ───────────────────────────────
const COMFY_URL = (process.env.COMFY_URL || '').replace(/\/$/, '');

function buildFluxWorkflow(prompt, seed, refName) {
  const unet  = process.env.COMFY_UNET  || 'flux1-dev-fp8.safetensors';
  const clip1 = process.env.COMFY_CLIP1 || 't5xxl_fp8_e4m3fn.safetensors';
  const clip2 = process.env.COMFY_CLIP2 || 'clip_l.safetensors';
  const vae   = process.env.COMFY_VAE   || 'ae.safetensors';
  const wf = {
    "1":  { class_type: "UNETLoader",       inputs: { unet_name: unet, weight_dtype: "fp8_e4m3fn" } },
    "2":  { class_type: "DualCLIPLoader",   inputs: { clip_name1: clip1, clip_name2: clip2, type: "flux" } },
    "3":  { class_type: "VAELoader",        inputs: { vae_name: vae } },
    "4":  { class_type: "CLIPTextEncode",   inputs: { clip: ["2", 0], text: prompt } },
    "5":  { class_type: "FluxGuidance",     inputs: { conditioning: ["4", 0], guidance: 3.5 } },
    "6":  { class_type: "CLIPTextEncode",   inputs: { clip: ["2", 0], text: "" } },
    "7":  { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
    "8":  {
      class_type: "KSampler",
      inputs: {
        model: ["1", 0], positive: ["5", 0], negative: ["6", 0],
        latent_image: ["7", 0],
        seed: seed ?? Math.floor(Math.random() * 2 ** 32),
        steps: 20, cfg: 1.0, sampler_name: "euler", scheduler: "simple", denoise: 1.0
      }
    },
    "9":  { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
    "10": { class_type: "SaveImage", inputs: { images: ["9", 0], filename_prefix: "llm-chat" } }
  };

  // Flux Redux: usa imagem de referência para manter o sujeito entre gerações
  if (refName) {
    const redux      = process.env.COMFY_REDUX       || 'flux1-redux-dev.safetensors';
    const clipVision = process.env.COMFY_CLIP_VISION || 'sigclip_vision_patch14_384.safetensors';
    const strength   = parseFloat(process.env.COMFY_REDUX_STRENGTH || '0.5');
    wf["11"] = { class_type: "LoadImage",        inputs: { image: refName } };
    wf["12"] = { class_type: "CLIPVisionLoader", inputs: { clip_name: clipVision } };
    wf["13"] = { class_type: "CLIPVisionEncode", inputs: { clip_vision: ["12", 0], image: ["11", 0], crop: "center" } };
    wf["14"] = { class_type: "StyleModelLoader", inputs: { style_model_name: redux } };
    wf["15"] = {
      class_type: "StyleModelApply",
      inputs: {
        conditioning: ["5", 0], style_model: ["14", 0], clip_vision_output: ["13", 0],
        strength, strength_type: "multiply"
      }
    };
    wf["8"].inputs.positive = ["15", 0];
  }
  return wf;
}

async function uploadRefToComfy(dataUrl) {
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) throw new Error('imagem de referência inválida');
  const buf  = Buffer.from(m[2], 'base64');
  const name = `llm-chat-ref-${Date.now()}.png`;
  const fd   = new FormData();
  fd.append('image', new Blob([buf], { type: m[1] }), name);
  fd.append('overwrite', 'true');
  const r = await fetch(`${COMFY_URL}/upload/image`, { method: 'POST', body: fd });
  if (!r.ok) throw new Error('falha ao enviar referência ao ComfyUI: HTTP ' + r.status);
  const j = await r.json();
  return j.name || name;
}

async function translatePrompt(text, hasReference = false) {
  const systemPrompt = hasReference
    ? 'Translate the following image description to English. Keep the subject/person EXACTLY as described — never substitute or invent different subjects. The SCENE and LOCATION are critical: expand them with rich, specific details (exact place, time of day, lighting conditions, weather, colors, surrounding elements, atmosphere). Use strong scene keywords so the environment overrides any previous visual context. Add photographic quality descriptors. Reply with ONLY the English prompt, nothing else.'
    : 'Translate the following image description to English. Keep the subject EXACTLY as described — never substitute or invent different subjects. Only add photographic quality descriptors (lighting, style, detail level). Reply with ONLY the English prompt, nothing else.';
  try {
    const r = await fetch(`${LLM_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: '',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text }
        ],
        temperature: 0.4,
        max_tokens: 200,
        stream: false
      })
    });
    if (!r.ok) return text;
    const j = await r.json();
    const translated = j.choices?.[0]?.message?.content?.trim();
    return translated || text;
  } catch {
    return text;
  }
}

app.post('/image', async (req, res) => {
  if (!COMFY_URL) return res.status(503).json({ error: 'COMFY_URL não configurado no .env' });
  const { prompt, seed, reference } = req.body;
  if (!prompt?.trim()) return res.status(400).json({ error: 'prompt obrigatório' });
  try {
    const optimizedPrompt = await translatePrompt(prompt.trim(), !!reference);
    console.log(`[image] prompt original: ${prompt.trim()}`);
    console.log(`[image] prompt otimizado: ${optimizedPrompt}`);
    let refName = null;
    if (reference) {
      refName = await uploadRefToComfy(reference);
      console.log(`[image] referência enviada: ${refName}`);
    }
    const submitResp = await fetch(`${COMFY_URL}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: buildFluxWorkflow(optimizedPrompt, seed, refName) })
    });
    if (!submitResp.ok) throw new Error('ComfyUI recusou o workflow: HTTP ' + submitResp.status);
    const { prompt_id } = await submitResp.json();

    // Polling até a imagem ficar pronta (timeout 6 min — Redux carrega modelos extras na 1ª vez)
    const deadline = Date.now() + 6 * 60 * 1000;
    let imageInfo = null;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 2000));
      const hist = await fetch(`${COMFY_URL}/history/${prompt_id}`).then(r => r.json());
      const outputs = hist[prompt_id]?.outputs;
      if (outputs) {
        const images = Object.values(outputs).flatMap(o => o.images ?? []);
        if (images.length) { imageInfo = images[0]; break; }
      }
    }
    if (!imageInfo) throw new Error('Timeout aguardando geração (3 min)');

    const { filename, subfolder, type } = imageInfo;
    const imgResp = await fetch(`${COMFY_URL}/view?${new URLSearchParams({ filename, subfolder, type })}`);
    if (!imgResp.ok) throw new Error('Erro ao buscar imagem: HTTP ' + imgResp.status);
    const buf  = Buffer.from(await imgResp.arrayBuffer());
    const mime = imgResp.headers.get('content-type') || 'image/png';
    res.json({ image: `data:${mime};base64,${buf.toString('base64')}` });
  } catch (err) {
    console.error('[image]', err.message);
    res.status(502).json({ error: err.message });
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

    const rawBuf = Buffer.from(await upstream.arrayBuffer());
    res.end(rawBuf);
  } catch (err) {
    console.error('[proxy]', err.message);
    res.status(502).json({ error: 'Erro ao contactar o servidor LLM', detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🤖 llm-chat rodando em http://localhost:${PORT}`);
  console.log(`   → LLM: ${LLM_URL}`);
});
