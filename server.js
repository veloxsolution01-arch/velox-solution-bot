import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import pg from 'pg';
import dns from 'node:dns';

// 🔧 Força IPv4 (evita ENETUNREACH por tentativa de IPv6 no Render)
dns.setDefaultResultOrder?.('ipv4first');

const app = express();
app.use(express.json());

// 🔌 Pool do Postgres (Supabase)
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL, // ex.: postgres://postgres:SUASENHA.@db.tjkbme...:5432/postgres?sslmode=require
  ssl: { rejectUnauthorized: false },
  keepAlive: true,
  connectionTimeoutMillis: 10_000
});

// Teste inicial de conexão e criação das tabelas necessárias
async function ensureSchema() {
  try {
    await pool.query('select 1');
    console.log('✅ DB ok');

    await pool.query(`
      create table if not exists tokens (
        ml_user_id bigint primary key,
        access_token text not null,
        refresh_token text not null,
        expires_at timestamptz not null,
        updated_at timestamptz default now()
      );

      create table if not exists answers (
        question_id bigint primary key,
        final text,
        mode text check (mode in ('auto','manual')),
        answered_at timestamptz
      );
    `);
    console.log('✅ Schema ok');
  } catch (e) {
    console.error('❌ DB erro:', e.message);
  }
}
ensureSchema();

// ========= Helpers Mercado Livre =========
async function mlFetch(path, token, opts = {}) {
  const r = await fetch(`https://api.mercadolibre.com${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  // Tente parsear JSON; se falhar, devolve texto para debug
  let json;
  try { json = await r.json(); } catch { json = null; }
  return json ?? { ok: r.ok, status: r.status };
}

// ========= Rotas de diagnóstico =========
app.get('/', (_req, res) => res.send('🚀 Velox ML Bot no ar'));
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// ========= Anti reuso do "code" =========
const usedCodes = new Map(); // code -> timestamp (ms)

// ========= OAuth: iniciar =========
app.get('/ml/connect', (req, res) => {
  const auth = new URL('https://auth.mercadolivre.com.br/authorization'); // BR = mercadolivre
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('client_id', process.env.ML_CLIENT_ID);
  auth.searchParams.set('redirect_uri', process.env.ML_REDIRECT_URI);
  console.log('🔗 OAuth URL:', auth.toString());
  res.redirect(auth.toString());
});

// ========= OAuth: callback =========
app.get('/ml/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).send('Faltou "code" do OAuth');

    // Evita reuso do mesmo "code" por 2 minutos
    const now = Date.now();
    if (usedCodes.has(code) && now - usedCodes.get(code) < 2 * 60 * 1000) {
      console.log('⚠️ code já usado, ignorando...');
      return res.status(400).send('Code já usado. Inicie novamente em /ml/connect.');
    }
    usedCodes.set(code, now);
    setTimeout(() => usedCodes.delete(code), 2 * 60 * 1000);

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: process.env.ML_CLIENT_ID,
      client_secret: process.env.ML_CLIENT_SECRET,
      code,
      redirect_uri: process.env.ML_REDIRECT_URI
    });

    const resp = await fetch('https://api.mercadolibre.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });

    const tok = await resp.json().catch(() => ({}));
    console.log('🔎 Resposta /oauth/token:', tok);

    if (!resp.ok || !tok.access_token) {
      return res
        .status(400)
        .send(`Erro no OAuth: ${tok.error || resp.status} - ${tok.error_description || 'sem descrição'}`);
    }

    const me = await mlFetch('/users/me', tok.access_token);
    if (!me?.id) {
      return res.status(400).send('Não foi possível obter /users/me');
    }

    const expiresAt = new Date(Date.now() + (tok.expires_in || 21600) * 1000); // 6h default

    await pool.query(`
      insert into tokens (ml_user_id, access_token, refresh_token, expires_at)
      values ($1, $2, $3, $4)
      on conflict (ml_user_id) do update set
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        expires_at   = excluded.expires_at,
        updated_at   = now()
    `, [me.id, tok.access_token, tok.refresh_token, expiresAt]);

    res.send('Conectado! Pode fechar a aba.');
  } catch (e) {
    console.error('OAuth callback error:', e);
    res.status(500).send('Erro no OAuth (exceção). Veja logs do Render.');
  }
});

// ========= Webhook: perguntas =========
app.post('/ml/webhook', async (req, res) => {
  try {
    const { topic, resource, user_id } = req.body || {};
    if (topic !== 'marketplace_questions' || !resource?.includes('/questions/')) {
      return res.sendStatus(200);
    }

    const qId = resource.split('/').pop();

    const { rows } = await pool.query(
      'select access_token from tokens where ml_user_id=$1',
      [user_id]
    );
    if (!rows.length) return res.sendStatus(200);

    const token = rows[0].access_token;
    const q = await mlFetch(`/questions/${qId}`, token);
    const item = await mlFetch(`/items/${q.item_id}`, token);

    const answer = await generateAI({
      question: q.text,
      title: item.title,
      price: item.price,
      shipping: item.shipping?.mode
    });

    // publica resposta
    await fetch('https://api.mercadolibre.com/answers', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ question_id: q.id, text: answer })
    });

    await pool.query(`
      insert into answers (question_id, final, mode, answered_at)
      values ($1, $2, 'auto', now())
      on conflict (question_id) do update set final=$2, mode='auto', answered_at=now()
    `, [q.id, answer]);

    res.sendStatus(200);
  } catch (e) {
    console.error('Webhook error:', e);
    res.sendStatus(200);
  }
});

// ========= Hugging Face =========
async function generateAI(ctx) {
  const prompt = `Você é atendente no Mercado Livre.
Título: ${ctx.title}
Preço: ${ctx.price}
Envio: ${ctx.shipping}
Pergunta: ${ctx.question}
Responda curto (1–2 frases), sem oferecer contato fora do ML.`;

  const r = await fetch('https://api-inference.huggingface.co/models/mistralai/Mistral-7B-Instruct-v0.2', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.HF_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ inputs: prompt, parameters: { max_new_tokens: 100 } })
  });

  let data;
  try { data = await r.json(); } catch { data = null; }

  return (Array.isArray(data) && data[0]?.generated_text?.slice(0, 900))
    || 'Estamos à disposição pelo Mercado Livre!';
}

// ========= Start =========
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('🚀 Server rodando na porta', PORT);
});
