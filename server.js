import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import pg from 'pg';
import dns from 'node:dns';

// 🔧 força IPv4 primeiro (evita ENETUNREACH em alguns provedores)
dns.setDefaultResultOrder('ipv4first');

const app = express();
app.use(express.json());

// ========= DB (Supabase) =========
// OBS: garanta que DATABASE_URL tem ?sslmode=require
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// teste rápido de conexão ao subir
pool
  .query('select 1')
  .then(() => console.log('✅ DB ok'))
  .catch(e => console.error('❌ DB erro:', e.message));

// ========= Helpers ML =========
async function oauthRefresh(ml_user_id) {
  const { rows } = await pool.query(
    'select refresh_token from tokens where ml_user_id = $1',
    [ml_user_id]
  );
  if (!rows.length) throw new Error('refresh_token não encontrado');
  const refresh_token = rows[0].refresh_token;

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: process.env.ML_CLIENT_ID,
    client_secret: process.env.ML_CLIENT_SECRET,
    refresh_token
  });

  const tok = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body
  }).then(r => r.json());

  if (!tok.access_token) throw new Error('Falha no refresh_token: ' + JSON.stringify(tok));

  const expiresAt = new Date(Date.now() + (tok.expires_in || 21600) * 1000);
  await pool.query(`
    update tokens
       set access_token = $1,
           refresh_token = coalesce($2, refresh_token),
           expires_at = $3,
           updated_at = now()
     where ml_user_id = $4
  `, [tok.access_token, tok.refresh_token, expiresAt, ml_user_id]);

  return tok.access_token;
}

async function mlFetchWithAutoRefresh(url, ml_user_id, access_token, opts = {}) {
  const doFetch = async (token) => {
    const r = await fetch(`https://api.mercadolibre.com${url}`, {
      ...opts,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(opts.headers || {})
      }
    });
    return r;
  };

  let res = await doFetch(access_token);
  if (res.status === 401) {
    const newToken = await oauthRefresh(ml_user_id);
    res = await doFetch(newToken);
  }
  if (!res.ok) {
    const text = await res.text().catch(()=> '');
    throw new Error(`ML ${res.status} ${res.statusText} – ${text}`);
  }
  return res.json();
}

const mlGET  = (path, uid, token) => mlFetchWithAutoRefresh(path, uid, token);
const mlPOST = (path, uid, token, bodyObj) =>
  mlFetchWithAutoRefresh(path, uid, token, { method:'POST', body: JSON.stringify(bodyObj) });

// ========= Rotas básicas =========
app.get('/', (_req, res) => res.send('🚀 Velox ML Bot no ar'));
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// ========= OAuth =========
app.get('/ml/connect', (req, res) => {
  const clientId = process.env.ML_CLIENT_ID;
  const redirectUri = process.env.ML_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    console.error('ENV faltando em /ml/connect', { clientId: !!clientId, redirectUri: !!redirectUri });
    return res.status(500).send('⚠️ Defina ML_CLIENT_ID e ML_REDIRECT_URI no Render.');
  }

  const auth = new URL('https://auth.mercadolivre.com.br/authorization'); // <- mercadolivre (com VRE)
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('client_id', clientId);
  auth.searchParams.set('redirect_uri', redirectUri);

  console.log('🔗 Redirecionando para OAuth:', auth.toString());
  res.redirect(auth.toString());
});

app.get('/ml/callback', async (req, res) => {
  try {
    console.log('📥 Query no callback:', req.query);

    if (req.query.error) {
      return res
        .status(400)
        .send(`Erro do OAuth (na autorização): ${req.query.error_description || req.query.error}`);
    }

    const { code } = req.query;
    if (!code) return res.status(400).send('Faltou "code" do OAuth');

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

    const tok = await resp.json();
    console.log('🔎 Resposta do /oauth/token:', tok);

    if (!resp.ok || !tok.access_token) {
      return res
        .status(400)
        .send(`Erro no OAuth (na troca do code): ${tok.error || resp.status} - ${tok.error_description || JSON.stringify(tok)}`);
    }

    // pega dados da conta
    const me = await fetch('https://api.mercadolibre.com/users/me', {
      headers: { Authorization: `Bearer ${tok.access_token}` }
    }).then(r => r.json());

    // cria tabelas se não existirem
    await pool.query(`
      create table if not exists shops (
        ml_user_id bigint primary key,
        nickname text,
        created_at timestamptz default now(),
        updated_at timestamptz default now()
      );
      create table if not exists tokens (
        ml_user_id bigint primary key references shops(ml_user_id) on delete cascade,
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

    const expiresAt = new Date(Date.now() + (tok.expires_in || 21600) * 1000);

    await pool.query(`
      insert into shops (ml_user_id, nickname) values ($1, $2)
      on conflict (ml_user_id) do update set nickname = excluded.nickname, updated_at = now()
    `, [me.id, me.nickname]);

    await pool.query(`
      insert into tokens (ml_user_id, access_token, refresh_token, expires_at)
      values ($1, $2, $3, $4)
      on conflict (ml_user_id) do update set
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        expires_at = excluded.expires_at,
        updated_at = now()
    `, [me.id, tok.access_token, tok.refresh_token, expiresAt]);

    res.send('Conectado! Pode fechar a aba.');
  } catch (e) {
    console.error('OAuth callback error:', e);
    res.status(500).send('Erro no OAuth (exceção). Veja logs do Render.');
  }
});

// ========= Webhook =========
app.post('/ml/webhook', async (req, res) => {
  try {
    const payload = req.body || {};
    const topic = payload.topic;
    const resource = payload.resource;
    const user_id = payload.user_id;

    const isQuestions =
      (topic && topic.toLowerCase().includes('questions')) &&
      resource && resource.includes('/questions/');

    if (!isQuestions) return res.sendStatus(200);

    const qId = resource.split('/').pop();

    const { rows } = await pool.query(
      'select access_token from tokens where ml_user_id=$1',
      [user_id]
    );
    if (!rows.length) return res.sendStatus(200);

    const token = rows[0].access_token;

    const q = await mlGET(`/questions/${qId}`, user_id, token);
    const item = await mlGET(`/items/${q.item_id}`, user_id, token);

    const answer = await generateAI({
      question: q.text,
      title: item.title,
      price: item.price,
      shipping: item.shipping?.mode,
      variations: Array.isArray(item.variations) ? item.variations.length : 0
    });

    await mlPOST('/answers', user_id, token, { question_id: q.id, text: answer });

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
  const system = `Você é atendente no Mercado Livre.
- Responda em PT-BR, curto (1–2 frases).
- Não ofereça contato fora do ML.
- Só prometa o que consta no anúncio.`;
  const user = `Título: ${ctx.title}
Preço: ${ctx.price}
Envio: ${ctx.shipping}
Variações: ${ctx.variations}
Pergunta: ${ctx.question}`;

  const prompt = `${system}\n---\n${user}`;

  const r = await fetch('https://api-inference.huggingface.co/models/mistralai/Mistral-7B-Instruct-v0.2', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.HF_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      inputs: prompt,
      parameters: { max_new_tokens: 120, temperature: 0.6, return_full_text: false }
    })
  });

  let data;
  try { data = await r.json(); } catch { data = null; }

  const text = Array.isArray(data) && data[0]?.generated_text
    ? data[0].generated_text
    : 'Estamos à disposição pelo Mercado Livre!';

  return text
    .replace(/whats(app)?|telegram|instagram|contato\s+externo/gi, 'apenas pelo Mercado Livre')
    .slice(0, 900);
}

// ========= Start =========
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`on ${PORT}`));
