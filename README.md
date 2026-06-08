# llm-chat

Interface web self-hosted para conversar com **qualquer LLM local** que exponha uma API compatível com OpenAI (Ollama, llama.cpp server, LM Studio, etc.).

---

## Visão Geral

```
Navegador
  │  fetch / SSE
  ▼
llm-chat (Node.js :4000)
  │  proxy /llm/* → LLM_URL
  ▼
LLM local (Ollama · llama.cpp · LM Studio…)
```

O servidor atua como **proxy leve**: serve o frontend estático, persiste conversas em JSON e repassa as chamadas ao backend LLM com suporte a streaming.

---

## Funcionalidades

- **Múltiplas conversas** — sidebar com lista, criação, renomeação inline e exclusão
- **Persistência** — conversas salvas em `data/conversations.json` (sem banco de dados)
- **Streaming em tempo real** — cursor animado enquanto o modelo responde (SSE)
- **Configurações por conversa** — modelo, temperatura, max tokens e system prompt
- **Contexto via arquivo** — faça upload de um `.txt` / `.md` / `.json` para incluir como contexto (truncado em 24 KB)
- **Indicador de status** — ponto verde/vermelho mostra se o backend LLM está acessível
- **Dark mode** — interface Bootstrap 5.3 escura, responsiva

---

## Stack

| Camada | Tecnologia |
|---|---|
| Runtime | Node.js 20+ |
| Framework | Express 4 |
| Upload | Multer |
| Frontend | HTML5 + Bootstrap 5.3 + Vanilla JS |
| Deploy | Docker + docker-compose |
| Persistência | JSON em disco (`data/`) |

---

## Configuração

Copie `.env.example` para `.env` e ajuste:

```env
PORT=4000
LLM_URL=http://192.168.100.57:5000   # IP/porta do seu servidor LLM local
```

`LLM_URL` é obrigatório — o servidor encerra com erro se não estiver definido.

---

## Execução

### Local (sem Docker)

```bash
npm install
npm run dev   # desenvolvimento com nodemon
# ou
npm start     # produção
```

Acesse `http://localhost:4000`.

### Docker Compose

```bash
docker compose up -d
```

As conversas ficam na pasta `./data/` fora do container (volume montado).

---

## Estrutura

```
llm-chat/
├── server.js          # API REST + proxy LLM + streaming SSE
├── public/
│   └── index.html     # SPA — toda a UI em um único arquivo
├── data/              # conversas.json (criado automaticamente)
├── Dockerfile
├── docker-compose.yml
└── .env.example
```

---

## Rotas da API

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/conversations` | Lista conversas (metadados, sem mensagens) |
| `POST` | `/conversations` | Cria conversa; body: `{ model, temperature, maxTokens, systemPrompt }` |
| `GET` | `/conversations/:id` | Retorna conversa completa com mensagens |
| `PATCH` | `/conversations/:id` | Atualiza campos da conversa (título, mensagens, settings…) |
| `DELETE` | `/conversations/:id` | Remove conversa |
| `POST` | `/upload-context` | Upload de arquivo de texto como contexto (`multipart/form-data`, campo `file`) |
| `ALL` | `/llm/*` | Proxy transparente para `LLM_URL` — preserva streaming SSE |

---

## Compatibilidade com backends LLM

Qualquer servidor que implemente a API OpenAI funciona:

| Backend | `LLM_URL` de exemplo |
|---|---|
| [Ollama](https://ollama.com) | `http://localhost:11434` |
| [llama.cpp server](https://github.com/ggml-org/llama.cpp) | `http://localhost:8080` |
| [LM Studio](https://lmstudio.ai) | `http://localhost:1234` |

---

## Licença

MIT
