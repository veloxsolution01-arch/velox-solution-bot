import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import pg from 'pg';

const app = express();
app.use(express.json());

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// Helper Mercado Livre API
async function mlFetch(url, token, opts={}) {
  const r = await fetch(`https://api.mercadolibre.com${url}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  return r.json();
}

// OAuth
app.get('/ml/connect', (req,res)=>{
  const auth = new URL('https://auth.mercadolibre.com.br/authorization');
  auth.searchParams.set('response_type','code');
  auth.searchParams.set('client_id', process.env.ML_CLIENT_ID);
  auth.searchParams.set('redirect_uri', process.env.ML_REDIRECT_URI);
  res.redirect(auth.toString());
});

app.get('/ml/callback', async (req,res)=>{
  const { code } = req.query;
  const body = new URLSearchParams({
    grant_type:'authorization_code',
    client_id:process.env.ML_CLIENT_ID,
    client_secret:process.env.ML_CLIENT_SECRET,
    code,
    redirect_uri:process.env.ML_REDIRECT_URI
  });
  const tok = await fetch('https://api.mercadolibre.com/oauth/token', {
    method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body
  }).then(r=>r.json());

  const me = await mlFetch('/users/me', tok.access_token);

  await pool.query(`
    insert into tokens (ml_user_id, access_token, refresh_token, expires_at)
    values ($1,$2,$3,now() + interval '6 hours')
    on conflict (ml_user_id) do update set
      access_token=$2, refresh_token=$3, expires_at=now() + interval '6 hours'
  `,[me.id,tok.access_token,tok.refresh_token]);

  res.send("Conectado! Pode fechar a aba.");
});

// Webhook: perguntas
app.post('/ml/webhook', async (req,res)=>{
  try {
    const { topic, resource, user_id } = req.body;
    if(topic==='marketplace_questions'){
      const qId = resource.split('/').pop();

      const { rows } = await pool.query('select access_token from tokens where ml_user_id=$1',[user_id]);
      if(!rows.length) return res.sendStatus(200);

      const token = rows[0].access_token;
      const q = await mlFetch(`/questions/${qId}`, token);
      const item = await mlFetch(`/items/${q.item_id}`, token);

      // Gerar resposta com Hugging Face
      const answer = await generateAI({
        question:q.text,
        title:item.title,
        price:item.price,
        shipping:item.shipping?.mode
      });

      // Publica automaticamente
      await mlFetch('/answers', token, {
        method:'POST',
        body:JSON.stringify({ question_id:q.id, text:answer })
      });

      await pool.query(`
        insert into answers (question_id, final, mode, answered_at)
        values ($1,$2,'auto',now())
        on conflict (question_id) do update set final=$2, mode='auto', answered_at=now()
      `,[q.id, answer]);
    }
  } catch(e){ console.error(e) }
  res.sendStatus(200);
});

// Hugging Face
async function generateAI(ctx){
  const prompt = `Você é atendente no Mercado Livre.
Título: ${ctx.title}
Preço: ${ctx.price}
Envio: ${ctx.shipping}
Pergunta: ${ctx.question}
Responda curto (1–2 frases), sem oferecer contato fora do ML.`;

  const r = await fetch('https://api-inference.huggingface.co/models/mistralai/Mistral-7B-Instruct-v0.2',{
    method:'POST',
    headers:{'Authorization':`Bearer ${process.env.HF_TOKEN}`,'Content-Type':'application/json'},
    body:JSON.stringify({inputs:prompt,parameters:{max_new_tokens:100}})
  });
  const data = await r.json();
  return data[0]?.generated_text?.slice(0,900) || "Estamos à disposição pelo Mercado Livre!";
}

app.listen(process.env.PORT||3000);
