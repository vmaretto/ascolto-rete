/*
ASCOLTO IN RETE – WEBAPP CRAWLER (MVP)
=================================================
Obiettivo: webapp full‑stack in un unico file Node.js che monitora fonti online (RSS + pagine seed),
analizza i contenuti con AI (riassunto, sentiment, stance) e mostra i risultati in una dashboard.

⚙️ Setup rapido
-------------------------------------------------
1) Crea una cartella vuota e incolla questo file come `server.js`.
2) In terminale:
   npm init -y
   npm i express better-sqlite3 axios cheerio node-cron cors dotenv rss-parser dayjs zod robots-parser marked openai uuid
3) Crea un file `.env` nella stessa cartella con:
   PORT=3030
   OPENAI_API_KEY=sk-...
   # Facoltativi
   APP_BASE_URL=http://localhost:3030
   CRAWL_USER_AGENT=AscoltoBot/1.0 (+mailto:contatti@example.com)
   CRAWL_CONCURRENCY=3
   CRAWL_DELAY_MS=1500
4) Avvia:  node server.js
5) Apri:   http://localhost:3030

🔐 Note legali & buone pratiche
-------------------------------------------------
- Rispetta robots.txt: il crawler esegue un controllo base e rallenta le richieste.
- Usa solo fonti che hai titolo a monitorare. Per siti di terzi, verifica termini d’uso.
- Questo MVP è a scopo dimostrativo: regola liste di fonti, frequenze e limiti.

🧠 AI integrata
-------------------------------------------------
- Usa l’API OpenAI per: riassunto, sentiment (positivo/negativo/neutro) e stance (favorevole/critico/neutro) rispetto a keyword del topic.
- Se non imposti OPENAI_API_KEY, il sistema funziona lo stesso con una fallback euristica (sentiment naive).

🗃️ Persistenza
-------------------------------------------------
- SQLite locale (file auto‑creato in ./data/ascolto.sqlite). Nessuna dipendenza esterna.

🧭 Cosa include l’MVP
-------------------------------------------------
- CRUD topic (keyword, domini inclusi/esclusi, feed RSS, seed pages).
- Crawl manuale per topic + job periodico (cron @hourly di default).
- Dedup per URL + hash contenuto.
- Dashboard con filtri, ricerca full‑text semplice, badge sentiment/stance, dettaglio item e alert base.

=================================================
*/

// ===== Imports
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import axios from 'axios';
import cheerio from 'cheerio';
import RSSParser from 'rss-parser';
import cron from 'node-cron';
import Database from 'better-sqlite3';
import dayjs from 'dayjs';
import { z } from 'zod';
import robotsParser from 'robots-parser';
import { marked } from 'marked';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';

// ===== Env
dotenv.config();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3030;
const BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;
const USER_AGENT = process.env.CRAWL_USER_AGENT || 'AscoltoBot/1.0 (+mailto:contact@localhost)';
const CRAWL_CONCURRENCY = process.env.CRAWL_CONCURRENCY ? Number(process.env.CRAWL_CONCURRENCY) : 3;
const CRAWL_DELAY_MS = process.env.CRAWL_DELAY_MS ? Number(process.env.CRAWL_DELAY_MS) : 1500;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
const rss = new RSSParser({ timeout: 20000 });

// ===== Paths & DB
const DATA_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
const DB_PATH = path.join(DATA_DIR, 'ascolto.sqlite');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS topics (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  keywords TEXT NOT NULL,         -- JSON array of strings
  include_domains TEXT NOT NULL,  -- JSON array of strings
  exclude_domains TEXT NOT NULL,  -- JSON array of strings
  rss_feeds TEXT NOT NULL,        -- JSON array of URLs
  seeds TEXT NOT NULL,            -- JSON array of URLs to start crawling
  cron_expr TEXT NOT NULL DEFAULT '@hourly',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  domain TEXT,
  title TEXT,
  content TEXT,
  html_excerpt TEXT,
  published_at TEXT,
  discovered_at TEXT NOT NULL,
  hash TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  FOREIGN KEY(topic_id) REFERENCES topics(id)
);

CREATE TABLE IF NOT EXISTS analyses (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL UNIQUE,
  summary TEXT,
  sentiment TEXT,          -- positive | neutral | negative
  stance TEXT,             -- favorevole | neutro | critico
  entities TEXT,           -- JSON array
  model TEXT,
  score REAL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(source_id) REFERENCES sources(id)
);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  message TEXT NOT NULL,
  payload TEXT,
  created_at TEXT NOT NULL,
  is_dismissed INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sources_topic ON sources(topic_id);
CREATE INDEX IF NOT EXISTS idx_analyses_sentiment ON analyses(sentiment);
`);

// ===== Helpers
const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const nowISO = () => dayjs().toISOString();

function hashContent(input) {
  return crypto.createHash('sha256').update(input || '').digest('hex');
}

function getDomain(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function normalizeArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(s => String(s).trim()).filter(Boolean);
  if (typeof value === 'string') {
    try {
      const maybe = JSON.parse(value);
      if (Array.isArray(maybe)) return maybe.map(s => String(s).trim()).filter(Boolean);
    } catch {}
    return value.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [];
}

function textFromHtml(html) {
  const $ = cheerio.load(html || '');
  // Rimuovi script/style/nav/footer
  ['script','style','noscript','nav','footer','header','aside'].forEach(sel => $(sel).remove());
  const article = $('article');
  const main = article.length ? article : $('main');
  const target = main.length ? main : $('body');
  const title = $('title').first().text().trim();
  const paragraphs = target.find('p').map((_, el) => $(el).text().trim()).get();
  const content = paragraphs.join('\n').replace(/\n{2,}/g,'\n');
  return { title, content: content.slice(0, 40000) }; // sicurezza
}

async function fetchRobots(url) {
  try {
    const { origin } = new URL(url);
    const robotsUrl = origin + '/robots.txt';
    const res = await axios.get(robotsUrl, { timeout: 10000, headers: { 'User-Agent': USER_AGENT } });
    return robotsParser(robotsUrl, res.data);
  } catch {
    return null;
  }
}

async function isAllowedByRobots(url) {
  try {
    const robots = await fetchRobots(url);
    if (!robots) return true; // se assente, assumiamo consentito (puoi invertire la policy se vuoi)
    return robots.isAllowed(url, USER_AGENT) !== false;
  } catch { return true; }
}

async function httpGet(url) {
  const res = await axios.get(url, { timeout: 20000, headers: { 'User-Agent': USER_AGENT } });
  return res.data;
}

function naiveSentiment(text) {
  const t = (text || '').toLowerCase();
  const neg = ['truffa','frode','scandalo','contraff','illegale','multato','sotto inchiesta','richiamo','problema','critico','sospetto'];
  const pos = ['eccellente','premiato','qualità','positivo','record','innovazione','successo'];
  let score = 0;
  pos.forEach(w => { if (t.includes(w)) score++; });
  neg.forEach(w => { if (t.includes(w)) score--; });
  return score > 0 ? 'positive' : score < 0 ? 'negative' : 'neutral';
}

async function aiAnalyze({ text, title, keywords }) {
  const joined = [title || '', text || ''].join('\n').slice(0, 8000);
  if (!openai) {
    const sentiment = naiveSentiment(joined);
    return {
      summary: (title || '').slice(0, 160),
      sentiment,
      stance: sentiment === 'negative' ? 'critico' : sentiment === 'positive' ? 'favorevole' : 'neutro',
      entities: [],
      model: 'heuristic',
      score: 0.5
    };
  }
  const sys = `Sei un analista media. Dato un contenuto (titolo+testo) e una lista di keyword del topic, rispondi in JSON con i campi: summary (max 60 parole), sentiment (positive|neutral|negative), stance (favorevole|neutro|critico) rispetto alle keyword, entities (max 8 entity salienti).`;
  const usr = `KEYWORDS: ${keywords.join(', ')}\n\nCONTENUTO:\n${joined}`;
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.2,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: usr }
    ],
    response_format: { type: 'json_object' }
  });
  const raw = completion.choices[0].message.content || '{}';
  let parsed = {};
  try { parsed = JSON.parse(raw); } catch {}
  return {
    summary: parsed.summary || (title || '').slice(0,160),
    sentiment: parsed.sentiment || naiveSentiment(joined),
    stance: parsed.stance || 'neutro',
    entities: parsed.entities || [],
    model: 'gpt-4o-mini',
    score: 0.9
  };
}

// ===== Repos
const insertTopic = db.prepare(`INSERT INTO topics (id,name,keywords,include_domains,exclude_domains,rss_feeds,seeds,cron_expr,is_active,created_at) VALUES (@id,@name,@keywords,@include_domains,@exclude_domains,@rss_feeds,@seeds,@cron_expr,@is_active,@created_at)`);
const listTopics = db.prepare(`SELECT * FROM topics ORDER BY created_at DESC`);
const getTopic = db.prepare(`SELECT * FROM topics WHERE id = ?`);
const upsertSource = db.prepare(`INSERT OR IGNORE INTO sources (id,topic_id,url,domain,title,content,html_excerpt,published_at,discovered_at,hash,status) VALUES (@id,@topic_id,@url,@domain,@title,@content,@html_excerpt,@published_at,@discovered_at,@hash,@status)`);
const updateSource = db.prepare(`UPDATE sources SET title=@title, content=@content, html_excerpt=@html_excerpt, published_at=@published_at, hash=@hash, status=@status WHERE id=@id`);
const getSourceByUrl = db.prepare(`SELECT * FROM sources WHERE url = ?`);
const listSources = db.prepare(`SELECT s.*, a.summary, a.sentiment, a.stance, a.entities FROM sources s LEFT JOIN analyses a ON a.source_id = s.id WHERE s.topic_id = @topic_id ORDER BY s.discovered_at DESC LIMIT @limit OFFSET @offset`);
const countSources = db.prepare(`SELECT COUNT(*) as n FROM sources WHERE topic_id = ?`);
const upsertAnalysis = db.prepare(`INSERT OR REPLACE INTO analyses (id,source_id,summary,sentiment,stance,entities,model,score,created_at) VALUES (@id,@source_id,@summary,@sentiment,@stance,@entities,@model,@score,@created_at)`);
const insertAlert = db.prepare(`INSERT INTO alerts (id,type,severity,message,payload,created_at,is_dismissed) VALUES (@id,@type,@severity,@message,@payload,@created_at,0)`);
const listAlerts = db.prepare(`SELECT * FROM alerts WHERE is_dismissed = 0 ORDER BY created_at DESC LIMIT 50`);
const dismissAlertStmt = db.prepare(`UPDATE alerts SET is_dismissed = 1 WHERE id = ?`);

// ===== Crawl core
async function crawlTopic(topicId, { maxItems = 40 } = {}) {
  const topic = getTopic.get(topicId);
  if (!topic) throw new Error('Topic non trovato');

  const keywords = normalizeArray(topic.keywords);
  const includeDomains = normalizeArray(topic.include_domains);
  const excludeDomains = normalizeArray(topic.exclude_domains);
  const rssFeeds = normalizeArray(topic.rss_feeds);
  const seeds = normalizeArray(topic.seeds);

  let discovered = 0;
  const queue = [];

  // 1) RSS
  for (const feed of rssFeeds) {
    try {
      const parsed = await rss.parseURL(feed);
      for (const item of parsed.items || []) {
        const link = item.link || item.guid;
        if (!link) continue;
        const domain = getDomain(link);
        if (includeDomains.length && !includeDomains.some(d => domain.endsWith(d))) continue;
        if (excludeDomains.some(d => domain.endsWith(d))) continue;
        queue.push({ url: link, published_at: item.isoDate || item.pubDate || null });
      }
    } catch (e) {
      console.warn('RSS error', feed, e.message);
    }
  }

  // 2) Seed pages → estrai link interni pertinenti
  for (const seed of seeds) {
    try {
      if (!(await isAllowedByRobots(seed))) continue;
      const html = await httpGet(seed);
      const $ = cheerio.load(html);
      const links = $('a[href]').map((_, a) => $(a).attr('href')).get();
      const abs = links
        .map(href => {
          try { return new URL(href, seed).toString(); } catch { return null; }
        })
        .filter(Boolean)
        .slice(0, 200);
      const domain = getDomain(seed);
      const filtered = abs.filter(u => getDomain(u).endsWith(domain));
      const keyworded = filtered.filter(u => {
        const uLow = u.toLowerCase();
        return keywords.some(k => uLow.includes(k.toLowerCase()));
      });
      keyworded.slice(0, 60).forEach(u => queue.push({ url: u, published_at: null }));
    } catch (e) {
      console.warn('Seed crawl error', seed, e.message);
    }
  }

  // Dedup queue by URL
  const seen = new Set();
  const finalQueue = [];
  for (const item of queue) {
    if (!item.url || seen.has(item.url)) continue;
    seen.add(item.url);
    finalQueue.push(item);
    if (finalQueue.length >= maxItems) break;
  }

  // 3) Process queue with limited concurrency
  const pool = Array(CRAWL_CONCURRENCY).fill(0).map(() => worker());
  let idx = 0;

  async function worker() {
    while (idx < finalQueue.length) {
      const cur = finalQueue[idx++];
      try {
        const allowed = await isAllowedByRobots(cur.url);
        if (!allowed) { await sleep(200); continue; }

        const exists = getSourceByUrl.get(cur.url);
        if (exists) { continue; }

        const html = await httpGet(cur.url);
        const { title, content } = textFromHtml(html);
        const excerpt = html.slice(0, 2000);
        const domain = getDomain(cur.url);
        const hash = hashContent(title + '\n' + content);

        const id = uuidv4();
        upsertSource.run({
          id,
          topic_id: topicId,
          url: cur.url,
          domain,
          title: title || null,
          content: content || null,
          html_excerpt: excerpt,
          published_at: cur.published_at,
          discovered_at: nowISO(),
          hash,
          status: 'fetched'
        });

        const analysis = await aiAnalyze({ text: content, title, keywords });
        upsertAnalysis.run({
          id: uuidv4(),
          source_id: id,
          summary: analysis.summary,
          sentiment: analysis.sentiment,
          stance: analysis.stance,
          entities: JSON.stringify(analysis.entities || []),
          model: analysis.model,
          score: analysis.score,
          created_at: nowISO()
        });

        if (analysis.sentiment === 'negative' || analysis.stance === 'critico') {
          insertAlert.run({
            id: uuidv4(),
            type: 'media-negative',
            severity: 'warning',
            message: `Rilevato contenuto critico: ${title?.slice(0,120) || cur.url}`,
            payload: JSON.stringify({ url: cur.url, topic_id: topicId }),
            created_at: nowISO()
          });
        }

        discovered++;
        await sleep(CRAWL_DELAY_MS);
      } catch (e) {
        console.warn('Crawl item error', cur.url, e.message);
      }
    }
  }

  await Promise.all(pool);
  return { discovered };
}

// ===== API Schemas
const TopicSchema = z.object({
  name: z.string().min(2),
  keywords: z.array(z.string()).nonempty(),
  include_domains: z.array(z.string()).optional().default([]),
  exclude_domains: z.array(z.string()).optional().default([]),
  rss_feeds: z.array(z.string()).optional().default([]),
  seeds: z.array(z.string()).optional().default([]),
  cron_expr: z.string().optional().default('@hourly'),
  is_active: z.boolean().optional().default(true)
});

// ===== Server
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use('/static', express.static(path.join(process.cwd(), 'static')));

// ---- API: Topics
app.get('/api/topics', (req, res) => {
  const rows = listTopics.all().map(r => ({
    ...r,
    keywords: JSON.parse(r.keywords),
    include_domains: JSON.parse(r.include_domains),
    exclude_domains: JSON.parse(r.exclude_domains),
    rss_feeds: JSON.parse(r.rss_feeds),
    seeds: JSON.parse(r.seeds)
  }));
  res.json(rows);
});

app.post('/api/topics', (req, res) => {
  try {
    const parsed = TopicSchema.parse(req.body);
    const id = uuidv4();
    insertTopic.run({
      id,
      name: parsed.name,
      keywords: JSON.stringify(parsed.keywords),
      include_domains: JSON.stringify(parsed.include_domains),
      exclude_domains: JSON.stringify(parsed.exclude_domains),
      rss_feeds: JSON.stringify(parsed.rss_feeds),
      seeds: JSON.stringify(parsed.seeds),
      cron_expr: parsed.cron_expr,
      is_active: parsed.is_active ? 1 : 0,
      created_at: nowISO()
    });
    res.json({ ok: true, id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---- API: Crawl now
app.post('/api/crawl/:topicId', async (req, res) => {
  try {
    const topicId = req.params.topicId;
    const { maxItems } = req.body || {};
    const out = await crawlTopic(topicId, { maxItems: Math.min(Number(maxItems) || 40, 200) });
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- API: Results
app.get('/api/results', (req, res) => {
  const topic_id = String(req.query.topicId || '');
  if (!topic_id) return res.status(400).json({ error: 'topicId richiesto' });
  const sentiment = req.query.sentiment ? String(req.query.sentiment) : '';
  const q = req.query.q ? String(req.query.q).toLowerCase() : '';
  const page = Math.max(1, Number(req.query.page || 1));
  const size = Math.min(50, Math.max(1, Number(req.query.size || 20)));
  const offset = (page - 1) * size;

  const total = countSources.get(topic_id).n;
  const rows = listSources.all({ topic_id, limit: size, offset });
  let filtered = rows;
  if (sentiment) filtered = filtered.filter(r => (r.sentiment || '') === sentiment);
  if (q) {
    filtered = filtered.filter(r => {
      const blob = [r.title||'', r.content||'', r.summary||''].join(' ').toLowerCase();
      return blob.includes(q);
    });
  }
  res.json({ total, page, size, items: filtered });
});

// ---- API: Alerts
app.get('/api/alerts', (req, res) => {
  const rows = listAlerts.all().map(r => ({ ...r, payload: r.payload ? JSON.parse(r.payload) : null }));
  res.json(rows);
});

app.post('/api/alerts/:id/dismiss', (req, res) => {
  dismissAlertStmt.run(req.params.id);
  res.json({ ok: true });
});

// ---- UI (single page)
app.get('/', (req, res) => {
  const html = `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Ascolto in rete – Crawler AI</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style> body { font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; } .chip{border-radius:9999px;padding:2px 10px;font-size:12px;font-weight:600} </style>
</head>
<body class="bg-slate-50">
  <div class="max-w-7xl mx-auto p-6 space-y-6">
    <header class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-bold">🔎 Ascolto in rete</h1>
        <p class="text-slate-600">Crawler con AI integrata • RSS + seed pages • sentiment & stance</p>
      </div>
      <div class="flex gap-3">
        <button id="refreshAlerts" class="px-3 py-2 bg-amber-500 text-white rounded-xl shadow">Aggiorna alert</button>
      </div>
    </header>

    <section class="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div class="lg:col-span-1 space-y-4">
        <div class="bg-white rounded-2xl shadow p-4">
          <h2 class="font-semibold mb-3">Nuovo topic</h2>
          <form id="topicForm" class="space-y-3">
            <input required name="name" placeholder="Nome topic" class="w-full border rounded-xl px-3 py-2" />
            <input required name="keywords" placeholder="Keyword (separate da virgola)" class="w-full border rounded-xl px-3 py-2" />
            <input name="include_domains" placeholder="Domini inclusi (opzionale)" class="w-full border rounded-xl px-3 py-2" />
            <input name="exclude_domains" placeholder="Domini esclusi (opzionale)" class="w-full border rounded-xl px-3 py-2" />
            <textarea name="rss_feeds" placeholder="Feed RSS (uno per riga)" class="w-full border rounded-xl px-3 py-2 h-20"></textarea>
            <textarea name="seeds" placeholder="Seed pages (uno per riga)" class="w-full border rounded-xl px-3 py-2 h-20"></textarea>
            <div class="flex items-center gap-2">
              <input name="cron_expr" placeholder="Cron es. @hourly" class="flex-1 border rounded-xl px-3 py-2" />
              <button class="px-3 py-2 bg-blue-600 text-white rounded-xl">Crea</button>
            </div>
          </form>
        </div>

        <div class="bg-white rounded-2xl shadow p-4">
          <h2 class="font-semibold mb-3">Topics</h2>
          <div id="topicsList" class="space-y-2"></div>
        </div>

        <div class="bg-white rounded-2xl shadow p-4">
          <h2 class="font-semibold mb-3">Alert</h2>
          <div id="alerts" class="space-y-3"></div>
        </div>
      </div>

      <div class="lg:col-span-2 space-y-4">
        <div class="bg-white rounded-2xl shadow p-4">
          <div class="flex items-center gap-3 mb-3">
            <select id="topicSelect" class="border rounded-xl px-3 py-2"></select>
            <button id="crawlBtn" class="px-3 py-2 bg-emerald-600 text-white rounded-xl">Esegui crawl</button>
            <input id="searchInput" placeholder="Cerca…" class="flex-1 border rounded-xl px-3 py-2" />
            <select id="sentimentFilter" class="border rounded-xl px-3 py-2">
              <option value="">Tutti</option>
              <option value="positive">Positivo</option>
              <option value="neutral">Neutro</option>
              <option value="negative">Negativo</option>
            </select>
          </div>
          <div id="results" class="divide-y"></div>
        </div>
      </div>
    </section>
  </div>

<script>
const api = {
  topics: () => fetch('/api/topics').then(r=>r.json()),
  createTopic: (payload) => fetch('/api/topics',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}).then(r=>r.json()),
  crawl: (topicId) => fetch('/api/crawl/'+topicId,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({maxItems:40})}).then(r=>r.json()),
  results: (topicId, params={}) => fetch('/api/results?'+new URLSearchParams({topicId, ...params})).then(r=>r.json()),
  alerts: () => fetch('/api/alerts').then(r=>r.json()),
  dismissAlert: (id) => fetch('/api/alerts/'+id+'/dismiss',{method:'POST'}).then(r=>r.json())
};

const el = (h) => { const e = document.createElement('div'); e.innerHTML = h; return e.firstElementChild; };

async function loadTopics() {
  const box = document.getElementById('topicsList');
  const select = document.getElementById('topicSelect');
  box.innerHTML = '<p class="text-slate-500">Caricamento…</p>';
  const topics = await api.topics();
  box.innerHTML = '';
  select.innerHTML = '';
  topics.forEach(t => {
    const item = el(`<div class="p-3 border rounded-xl flex items-center justify-between">
      <div>
        <div class="font-semibold">${t.name}</div>
        <div class="text-xs text-slate-500">${t.keywords.join(', ')}</div>
      </div>
      <button data-id="${t.id}" class="crawlNow px-2 py-1 text-sm bg-emerald-700 text-white rounded-lg">Crawl</button>
    </div>`);
    box.appendChild(item);

    const opt = document.createElement('option');
    opt.value = t.id; opt.textContent = t.name;
    select.appendChild(opt);
  });

  document.querySelectorAll('.crawlNow').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.textContent = 'In corso…';
      const out = await api.crawl(btn.dataset.id);
      btn.textContent = 'Crawl'; btn.disabled = false;
      alert('Nuovi contenuti: '+(out.discovered||0));
      renderResults();
      loadAlerts();
    });
  });
}

async function renderResults() {
  const topicId = document.getElementById('topicSelect').value;
  const q = document.getElementById('searchInput').value;
  const sentiment = document.getElementById('sentimentFilter').value;
  if (!topicId) return;
  const data = await api.results(topicId, { q, sentiment });
  const box = document.getElementById('results');
  if (!data.items.length) { box.innerHTML = '<div class="p-6 text-slate-500">Nessun risultato</div>'; return; }
  box.innerHTML = data.items.map(item => {
    const chip = item.sentiment === 'negative' ? 'bg-red-100 text-red-700' : item.sentiment === 'positive' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-700';
    const stance = item.stance || 'neutro';
    const ents = (()=>{ try { return JSON.parse(item.entities||'[]'); } catch{ return []; } })();
    return `<article class="p-4 hover:bg-slate-50">
      <div class="flex items-center justify-between">
        <a href="${item.url}" target="_blank" class="font-semibold hover:underline">${item.title || item.url}</a>
        <div class="flex items-center gap-2">
          <span class="chip ${chip}">${item.sentiment||'?'}</span>
          <span class="chip bg-indigo-100 text-indigo-700">${stance}</span>
        </div>
      </div>
      <div class="text-sm text-slate-600 mt-1">${item.domain || ''}</div>
      <p class="text-sm mt-2">${(item.summary||'').replace(/</g,'&lt;')}</p>
      ${ents.length?`<div class="mt-2 text-xs text-slate-500">Entità: ${ents.join(', ')}</div>`:''}
      <div class="text-xs text-slate-400 mt-1">Pubblicato: ${item.published_at || '—'} · Scoperto: ${item.discovered_at}</div>
    </article>`;
  }).join('');
}

async function loadAlerts() {
  const box = document.getElementById('alerts');
  const items = await api.alerts();
  if (!items.length) { box.innerHTML = '<p class="text-slate-500">Nessun alert</p>'; return; }
  box.innerHTML = '';
  items.forEach(a => {
    const node = el(`<div class="p-3 border rounded-xl">
      <div class="flex items-center justify-between">
        <div class="font-semibold">${a.type}</div>
        <button data-id="${a.id}" class="dismiss px-2 py-1 text-sm bg-slate-200 rounded-lg">Ok</button>
      </div>
      <div class="text-sm mt-1">${a.message}</div>
      <div class="text-xs text-slate-500">${a.created_at}</div>
    </div>`);
    box.appendChild(node);
  });
  document.querySelectorAll('.dismiss').forEach(btn => {
    btn.addEventListener('click', async () => { await api.dismissAlert(btn.dataset.id); loadAlerts(); });
  });
}

// Handlers

document.getElementById('topicForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.currentTarget);
  const payload = {
    name: fd.get('name'),
    keywords: String(fd.get('keywords')||'').split(',').map(s=>s.trim()).filter(Boolean),
    include_domains: String(fd.get('include_domains')||'').split(',').map(s=>s.trim()).filter(Boolean),
    exclude_domains: String(fd.get('exclude_domains')||'').split(',').map(s=>s.trim()).filter(Boolean),
    rss_feeds: String(fd.get('rss_feeds')||'').split('\n').map(s=>s.trim()).filter(Boolean),
    seeds: String(fd.get('seeds')||'').split('\n').map(s=>s.trim()).filter(Boolean),
    cron_expr: fd.get('cron_expr') || '@hourly',
    is_active: true
  };
  const out = await api.createTopic(payload);
  if (out.error) return alert(out.error);
  e.currentTarget.reset();
  await loadTopics();
});

document.getElementById('crawlBtn').addEventListener('click', async () => {
  const topicId = document.getElementById('topicSelect').value;
  if (!topicId) return alert('Seleziona un topic');
  const btn = document.getElementById('crawlBtn');
  btn.disabled = true; btn.textContent = 'In corso…';
  const out = await api.crawl(topicId);
  btn.textContent = 'Esegui crawl'; btn.disabled = false;
  alert('Nuovi contenuti: '+(out.discovered||0));
  renderResults();
  loadAlerts();
});

document.getElementById('topicSelect').addEventListener('change', renderResults);
document.getElementById('sentimentFilter').addEventListener('change', renderResults);
document.getElementById('searchInput').addEventListener('input', () => { clearTimeout(window.__srch); window.__srch = setTimeout(renderResults, 350); });

document.getElementById('refreshAlerts').addEventListener('click', loadAlerts);

// Init
(async function init(){ await loadTopics(); await loadAlerts(); setTimeout(renderResults, 400); })();
</script>
</body>
</html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// ===== Cron (simple orchestrator)
// Nota: per semplicità, pianifichiamo @hourly per i topic attivi all'avvio.
function scheduleJobs() {
  const topics = listTopics.all();
  topics.forEach(t => {
    if (!t.is_active) return;
    const expr = t.cron_expr || '@hourly';
    try {
      // node-cron non supporta "@hourly" direttamente → traduciamo a "0 * * * *"
      const cronExpr = expr === '@hourly' ? '0 * * * *' : expr === '@daily' ? '0 3 * * *' : expr;
      cron.schedule(cronExpr, async () => {
        console.log(`[CRON] Crawling topic ${t.name}`);
        try { await crawlTopic(t.id, { maxItems: 40 }); } catch(e){ console.warn('Cron crawl error', e.message); }
      });
    } catch(e) { console.warn('Cron schedule error', t.name, e.message); }
  });
}

scheduleJobs();

app.listen(PORT, () => {
  console.log(`Ascolto in rete avviato su ${BASE_URL}`);
  // Bootstrap: se non ci sono topic, creane uno di esempio
  const count = db.prepare('SELECT COUNT(*) as n FROM topics').get().n;
  if (!count) {
    const demo = {
      id: uuidv4(),
      name: 'Olio di Roma IGP – demo',
      keywords: JSON.stringify(['olio di roma','igp','consorzio','lazio','evocazione']),
      include_domains: JSON.stringify([]),
      exclude_domains: JSON.stringify(['facebook.com','instagram.com']),
      rss_feeds: JSON.stringify([
        // Inserisci feed rilevanti, es.:
        // 'https://news.google.com/rss/search?q=%22Olio%20di%20Roma%22',
      ]),
      seeds: JSON.stringify([
        // Pagine seed (elenchi news, rassegna stampa, ecc.)
        // 'https://www.regione.lazio.it/notizie',
      ]),
      cron_expr: '@hourly',
      is_active: 1,
      created_at: nowISO()
    };
    insertTopic.run(demo);
    console.log('Creato topic demo. Aggiungi i tuoi feed/seeds dalla UI.');
  }
});
