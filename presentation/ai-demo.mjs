// Mazs serveris AI demo lapai — bez atkarībām, tikai node:http.
//
//   GET  /             → ai-demo.html
//   GET  /measure      → ai-sources/measure.json (avotu kaudzes mērījums)
//   POST /api/tokens   → { tokens } — precīzs skaits ar tiktoken (ai_tokens.py)
//   POST /api/ask      → { mode, model, answer }
//
// API atslēga paliek serverī. Ja ANTHROPIC_API_KEY vai OPENAI_API_KEY nav,
// atdodam iepriekš sagatavotu atbildi (ai-sources/answer-<kadastrs>.md)
// un lapā to godīgi iezīmējam kā „sagatavotu”.
//
// Lietojums: node ai-demo.mjs   (PORT=4177 pēc noklusējuma)
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const HERE = new URL('./', import.meta.url).pathname;
const PORT = Number(process.env.PORT || 4177);

const SYSTEM = [
  'Tu esi palīgs, kas atbild latviski par vienu zemes vienību.',
  'Vienīgais datu avots ir pievienotais JSON no „Vienotais Zemes Reģistrs”.',
  'Neizdomā faktus. Ja avoti nesakrīt, pasaki to. Īsi, ar virsrakstiem treknrakstā.',
  'Beigās uzskaiti, kurus `source` laukus izmantoji.',
].join(' ');

/* ------------------------------------------------------------------
 * Tokenu skaitīšana: python ar tiktoken, lai skaitlis sakristu ar slaidu.
 * ---------------------------------------------------------------- */
function countTokens(text) {
  return new Promise((resolve) => {
    const py = spawn(`${HERE}.venv/bin/python`, [`${HERE}ai_tokens.py`, '--stdin']);
    let out = '';
    py.stdout.on('data', (d) => (out += d));
    py.on('close', () => resolve(Number(out.trim()) || Math.round(text.length / 4)));
    py.on('error', () => resolve(Math.round(text.length / 4)));
    py.stdin.end(text);
  });
}

/* ------------------------------------------------------------------
 * Dzīvā atbilde — Anthropic vai OpenAI, kas nu ir pieejams.
 * ---------------------------------------------------------------- */
async function askLive(question, json) {
  const user = `${question}\n\nDati (JSON):\n${json}`;

  if (process.env.ANTHROPIC_API_KEY) {
    const model = process.env.AI_MODEL || 'claude-sonnet-4-5';
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model, max_tokens: 1200, system: SYSTEM, messages: [{ role: 'user', content: user }] }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || res.statusText);
    return { model, answer: data.content.map((c) => c.text || '').join('') };
  }

  if (process.env.OPENAI_API_KEY) {
    const model = process.env.AI_MODEL || 'gpt-4o-mini';
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }] }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || res.statusText);
    return { model, answer: data.choices[0].message.content };
  }

  return null;
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => resolve(body));
  });
}

const send = (res, code, type, body) => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
};

createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
      return send(res, 200, 'text/html; charset=utf-8', readFileSync(`${HERE}ai-demo.html`));
    }
    if (req.method === 'GET' && req.url === '/measure') {
      return send(res, 200, 'application/json', readFileSync(`${HERE}ai-sources/measure.json`));
    }
    if (req.method === 'POST' && req.url === '/api/tokens') {
      const text = await readBody(req);
      return send(res, 200, 'application/json', JSON.stringify({ tokens: await countTokens(text) }));
    }
    if (req.method === 'POST' && req.url === '/api/ask') {
      const { question, json } = JSON.parse(await readBody(req));
      const cad = (() => {
        try {
          return JSON.parse(json).cadastre;
        } catch {
          return '';
        }
      })();

      // Vispirms mēģinām dzīvi; ja nav atslēgas vai API krīt — sagatavotā.
      let live = null;
      try {
        live = await askLive(question, json);
      } catch (e) {
        console.log('live AI kļūda:', e.message);
      }
      if (live) return send(res, 200, 'application/json', JSON.stringify({ mode: 'live', ...live }));

      const file = `${HERE}ai-sources/answer-${cad}.md`;
      const answer = existsSync(file)
        ? readFileSync(file, 'utf8')
        : 'Šim kadastram sagatavotas atbildes nav. Iestati ANTHROPIC_API_KEY vai OPENAI_API_KEY dzīvai atbildei.';
      return send(res, 200, 'application/json', JSON.stringify({ mode: 'prepared', model: null, answer }));
    }
    send(res, 404, 'text/plain', 'nav');
  } catch (e) {
    send(res, 500, 'text/plain', String(e?.message || e));
  }
}).listen(PORT, () => console.log(`AI demo → http://localhost:${PORT}`));
