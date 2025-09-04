/*
ASCOLTO IN RETE – WEBAPP CRAWLER (MVP) — server.js (versione robusta)
======================================================================
Requisiti:
- package.json con: { "type": "module", "scripts": { "start": "node server.js" } }
- .env (facoltativa) con: OPENAI_API_KEY=sk-...
*/

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import axios from 'axios';
import * as cheerio from 'cheerio';   // ✅ ESM
import RSSParser from 'rss-parser';
import cron from 'node-cron';
import Database from 'better-sqlite3';
import dayjs from 'dayjs';
import { z } from 'zod';
import robotsParser from 'robots-parser';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';

// ===== Env
dotenv.config();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3030;
const BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;
const USER_AGENT = process.env.CRAWL_USER_AGENT || 'AscoltoBot/1.0 (+mailto:contact@localhost)';
const CRAWL_CONCURRENCY = Number(process.env.CRAWL_CONCURRENCY || 3);
const CRAWL_DELAY_MS = Number(process.env.CRAWL_DELAY_MS || 1500);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

// ===== Google Custom Search API
// Per effettuare ricerche generiche sul web usiamo le API di Google (Custom Search JSON API).
// Imposta GOOGLE_API_KEY e GOOGLE_CSE_ID nel file .env per abilitarle. Se non sono presenti,
// la ricerca web sarà ignorata.
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || '';
const GOOGLE_CSE_ID = process.env.GOOGLE_CSE_ID || '';

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
const rss = new RSSParser({ timeout: 20000 });

// ===== Paths & DB
const DATA_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
const DB_PATH = path.join(DATA_DIR, 'ascolto.sqlite');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ===== Schema DB
db.exec(`
CREATE TABLE IF NOT EXISTS topics (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  keywords TEXT NOT NULL,         -- JSON array of strings
  include_domains TEXT NOT NULL,  -- JSON array of strings
  exclude_domains TEXT NOT NULL,  -- JSON array of strings
  rss_feeds TEXT NOT NULL,        -- JSON array of URLs
  seeds TEXT NOT NULL,            -- JSON array of URLs
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
const hashContent = (input) => crypto.createHash('sha256').update(input || '').digest('hex');
const getDomain = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
function normalizeArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(s => String(s).trim()).filter(Boolean);
  if (typeof value === 'string') {
    try { const maybe = JSON.parse(value); if (Array.isArray(maybe)) return maybe.map(s => String(s).trim()).filter(Boolean); } catch {}
    return value.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [];
}
function textFromHtml(html) {
  const $ = cheerio.load(html || '');
  ['script','style','noscript','nav','footer','header','aside'].forEach(sel => $(sel).remove());
  const container = $('article').length ? $('article') : ($('main').length ? $('main') : $('body'));
  const title = $('title').first().text().trim();
  const paragraphs = container.find('p').map((_, el) => $(el).text().trim()).get();
  const content = paragraphs.join('\n').replace(/\n{2,}/g,'\n');
  return { title, content: content.slice(0, 40000) };
}
async function fetchRobots(url) {
  try { const { origin } = new URL(url);
    const robotsUrl = origin + '/robots.txt';
    const res = await axios.get(robotsUrl, { timeout: 10000, headers: { 'User-Agent': USER_AGENT } });
    return robotsParser(robotsUrl, res.data);
  } catch { return null; }
}
async function isAllowedByRobots(url) {
  try { const robots = await fetchRobots(url); if (!robots) return true; return robots.isAllowed(url, USER_AGENT) !== false; }
  catch { return true; }
}
async function httpGet(url) {
  const res = await axios.get(url, { timeout: 20000, headers: { 'User-Agent': USER_AGENT } });
  return res.data;
}
function naiveSentiment(text) {
  const t = (text || '').toLowerCase();
  const neg = ['truffa','frode','scandalo','contraff','illegale','multato','sotto inchiesta','richiamo','problema','critico','sospetto'];
  const pos = ['eccellente','premiato','qualità','positivo','record','innovazione','successo'];
  let score = 0; pos.forEach(w => { if (t.includes(w)) score++; }); neg.forEach(w => { if (t.includes(w)) score--; });
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
  const sys = `Sei un analista media. Dato un contenuto (titolo+testo) e una lista di keyword del topic, rispondi in JSON con: summary (max 60 parole), sentiment (positive|neutral|negative), stance (favorevole|neutro|critico), entities (max 8).`;
  const usr = `KEYWORDS: ${keywords.join(', ')}\n\nCONTENUTO:\n${joined}`;
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.2,
    messages: [{ role:'system', content: sys }, { role:'user', content: usr }],
    response_format: { type: 'json_object' }
  });
  const raw = completion.choices[0].message.content || '{}';
  let parsed = {}; try { parsed = JSON.parse(raw); } catch {}
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
const getSourceByUrl = db.prepare(`SELECT * FROM sources WHERE url = ?`);
const listSources = db.prepare(`SELECT s.*, a.summary, a.sentiment, a.stance, a.entities FROM sources s LEFT JOIN analyses a ON a.source_id = s.id WHERE s.topic_id = @topic_id ORDER BY s.discovered_at DESC LIMIT @limit OFFSET @offset`);
const countSources = db.prepare(`SELECT COUNT(*) as n FROM sources WHERE topic_id = ?`);
const upsertAnalysis = db.prepare(`INSERT OR REPLACE INTO analyses (id,source_id,summary,sentiment,stance,entities,model,score,created_at) VALUES (@id,@source_id,@summary,@sentiment,@stance,@entities,@model,@score,@created_at)`);
const insertAlert = db.prepare(`INSERT INTO alerts (id,type,severity,message,payload,created_at,is_dismissed) VALUES (@id,@type,@severity,@message,@payload,@created_at,0)`);
const listAlerts = db.prepare(`SELECT * FROM alerts WHERE is_dismissed = 0 ORDER BY created_at DESC LIMIT 50`);
const dismissAlertStmt = db.prepare(`UPDATE alerts SET is_dismissed = 1 WHERE id = ?`);

// ===== Crawl
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

  // 0) Ricerca web generica tramite Google Custom Search API. Se API key e ID sono
  // presenti e ci sono keyword, effettuiamo una query combinando le parole con OR. Gli
  // URL trovati vengono filtrati per domini inclusi/esclusi e aggiunti alla coda.
  if (GOOGLE_API_KEY && GOOGLE_CSE_ID && keywords.length) {
    try {
      const query = keywords.join(' OR ');
      const searchRes = await axios.get('https://www.googleapis.com/customsearch/v1', {
        params: {
          key: GOOGLE_API_KEY,
          cx: GOOGLE_CSE_ID,
          q: query,
          num: 10
        }
      });
      const items = searchRes.data.items || [];
      for (const item of items) {
        const link = item.link;
        if (!link) continue;
        const domain = getDomain(link);
        if (includeDomains.length && !includeDomains.some(d => domain.endsWith(d))) continue;
        if (excludeDomains.some(d => domain.endsWith(d))) continue;
        queue.push({ url: link, published_at: null });
      }
    } catch (e) {
      console.warn('Google search error', e.message);
    }
  }

  // 1) RSS
  for (const feed of rssFeeds) {
    try {
      const parsed = await rss.parseURL(feed);
      for (const item of (parsed.items || [])) {
        const link = item.link || item.guid;
        if (!link) continue;
        const domain = getDomain(link);
        if (includeDomains.length && !includeDomains.some(d => domain.endsWith(d))) continue;
        if (excludeDomains.some(d => domain.endsWith(d))) continue;
        queue.push({ url: link, published_at: item.isoDate || item.pubDate || null });
      }
    } catch (e) { console.warn('RSS error', feed, e.message); }
  }

  // 2) Seed pages
  for (const seed of seeds) {
    try {
      if (!(await isAllowedByRobots(seed))) continue;
      const html = await httpGet(seed);
      const $ = cheerio.load(html);
      const links = $('a[href]').map((_, a) => $(a).attr('href')).get();
      const abs = links.map(href => { try { return new URL(href, seed).toString(); } catch { return null; } })
                       .filter(Boolean).slice(0, 200);
      const domain = getDomain(seed);
      const filtered = abs.filter(u => getDomain(u).endsWith(domain));
      const keyworded = filtered.filter(u => {
        const uLow = u.toLowerCase();
        return keywords.some(k => uLow.includes(k.toLowerCase()));
      });
      keyworded.slice(0, 60).forEach(u => queue.push({ url: u, published_at: null }));
    } catch (e) { console.warn('Seed crawl error', seed, e.message); }
  }

  // Dedup
  const seen = new Set(); const finalQueue = [];
  for (const item of queue) {
    if (!item.url || seen.has(item.url)) continue;
    seen.add(item.url); finalQueue.push(item);
    if (finalQueue.length >= maxItems) break;
  }

  // Concurrency
  const pool = Array(CRAWL_CONCURRENCY).fill(0).map(() => worker());
  let idx = 0;
  async function worker() {
    while (idx < finalQueue.length) {
      const cur = finalQueue[idx++];
      try {
        const allowed = await isAllowedByRobots(cur.url);
        if (!allowed) { await sleep(200); continue; }

        const exists = getSourceByUrl.get(cur.url);
        if (exists) continue;

        const html = await httpGet(cur.url);
        const { title, content } = textFromHtml(html);
        const excerpt = html.slice(0, 2000);
        const domain = getDomain(cur.url);
        const hash = hashContent(title + '\n' + content);

        const id = uuidv4();
        upsertSource.run({
          id, topic_id: topicId, url: cur.url, domain,
          title: title || null, content: content || null,
          html_excerpt: excerpt, published_at: cur.published_at,
          discovered_at: nowISO(), hash, status: 'fetched'
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
      } catch (e) { console.warn('Crawl item error', cur.url, e.message); }
    }
  }
  await Promise.all(pool);
  return { discovered };
}

// ===== Schemi API
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
app.use(express.urlencoded({ extended: true })); // ✅ accetta form POST classici
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

// accetta sia JSON che form-urlencoded; in caso di form fa redirect 303
app.post('/api/topics', (req, res) => {
  try {
    const body = req.is('application/json') ? req.body : (() => {
      const csv = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
      const lines = s => String(s || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
      return {
        name: req.body.name,
        keywords: csv(req.body.keywords),
        include_domains: csv(req.body.include_domains),
        exclude_domains: csv(req.body.exclude_domains),
        rss_feeds: lines(req.body.rss_feeds),
        seeds: lines(req.body.seeds),
        cron_expr: req.body.cron_expr && String(req.body.cron_expr).trim() !== '' ? String(req.body.cron_expr).trim() : '@hourly',
        is_active: true
      };
    })();

    const parsed = TopicSchema.parse(body);
    const id = uuidv4();
    insertTopic.run({
      id,
      name: parsed.name,
      keywords: JSON.stringify(parsed.keywords),
      include_domains: JSON.stringify(parsed.include_domains),
      exclude_domains: JSON.stringify(parsed.exclude_domains),
      rss_feeds: JSON.stringify(parsed.rss_feeds),
      seeds: JSON.stringify(parsed.seeds),
      cron_expr: parsed.cron_expr || '@hourly',
      is_active: parsed.is_active ? 1 : 0,
      created_at: nowISO()
    });

    const wantsHtml = (req.headers.accept || '').includes('text/html');
    if (!req.is('application/json') && wantsHtml) {
      res.status(303).set('Location', '/').end();
    } else {
      res.json({ ok: true, id });
    }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  if (q) filtered = filtered.filter(r => [r.title||'', r.content||'', r.summary||''].join(' ').toLowerCase().includes(q));
  res.json({ total, page, size, items: filtered });
});

// ---- API: Alerts
app.get('/api/alerts', (req, res) => {
  const rows = listAlerts.all().map(r => ({ ...r, payload: r.payload ? JSON.parse(r.payload) : null }));
  res.json(rows);
});
app.post('/api/alerts/:id/dismiss', (req, res) => { dismissAlertStmt.run(req.params.id); res.json({ ok: true }); });

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
          <form id="topicForm" class="space-y-4">
            <div>
              <label for="name" class="block text-sm font-medium text-slate-700">Nome topic</label>
              <input id="name" required name="name" placeholder="Es. Olio di Roma" class="mt-1 w-full border rounded-xl px-3 py-2" />
            </div>
            <div>
              <label for="keywords" class="block text-sm font-medium text-slate-700">Keyword (separate da virgola)</label>
              <input id="keywords" required name="keywords" placeholder="roma, lazio" class="mt-1 w-full border rounded-xl px-3 py-2" />
            </div>
            <div>
              <label for="include_domains" class="block text-sm font-medium text-slate-700">Domini inclusi (opzionale)</label>
              <input id="include_domains" name="include_domains" placeholder="es. ilsole24ore.com, ansa.it" class="mt-1 w-full border rounded-xl px-3 py-2" />
            </div>
            <div>
              <label for="exclude_domains" class="block text-sm font-medium text-slate-700">Domini esclusi (opzionale)</label>
              <input id="exclude_domains" name="exclude_domains" placeholder="es. facebook.com, instagram.com" class="mt-1 w-full border rounded-xl px-3 py-2" />
            </div>
            <div>
              <label for="rss_feeds" class="block text-sm font-medium text-slate-700">Feed RSS (uno per riga)</label>
              <textarea id="rss_feeds" name="rss_feeds" placeholder="https://example.com/feed" class="mt-1 w-full border rounded-xl px-3 py-2 h-20"></textarea>
            </div>
            <div>
              <label for="seeds" class="block text-sm font-medium text-slate-700">Seed pages (uno per riga)</label>
              <textarea id="seeds" name="seeds" placeholder="https://example.com/notizie" class="mt-1 w-full border rounded-xl px-3 py-2 h-20"></textarea>
            </div>
            <div class="flex items-center gap-2">
              <label for="cron_expr" class="block text-sm font-medium text-slate-700 flex-none">Cron</label>
              <input id="cron_expr" name="cron_expr" placeholder="es. @hourly" class="flex-1 border rounded-xl px-3 py-2" />
            </div>
            <div id="topicMessage" class="text-sm mt-2"></div>
            <button type="submit" class="px-3 py-2 bg-blue-600 text-white rounded-xl w-full">Crea</button>
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
          <div id="crawlMessage" class="text-sm mt-1"></div>
          <div id="results" class="divide-y"></div>
        </div>
      </div>
    </section>
  </div>

<script>
const api = {
  topics: () => fetch('/api/topics').then(function(r){return r.json();}),
  crawl: (topicId) => fetch('/api/crawl/'+topicId,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({maxItems:40})}).then(function(r){return r.json();}),
  results: (topicId, params) => { params=params||{}; return fetch('/api/results?'+new URLSearchParams(Object.assign({topicId:topicId},params))).then(function(r){return r.json();}); },
  alerts: () => fetch('/api/alerts').then(function(r){return r.json();}),
  dismissAlert: (id) => fetch('/api/alerts/'+id+'/dismiss',{method:'POST'}).then(function(r){return r.json();})
};
var el = function(h){ var e=document.createElement('div'); e.innerHTML=h; return e.firstElementChild; };

// Utility per mostrare messaggi in modo accessibile.
// type: 'info', 'success', 'error' -> controlla colore
function showMessage(id, text, type) {
  var box = document.getElementById(id);
  if (!box) return;
  box.textContent = text;
  var base = 'mt-2 text-sm';
  var color;
  switch (type) {
    case 'success': color = 'text-emerald-700'; break;
    case 'error': color = 'text-red-700'; break;
    default: color = 'text-slate-700'; break;
  }
  box.className = base + ' ' + color;
  // Nasconde il messaggio dopo 6 secondi
  clearTimeout(box._timer);
  box._timer = setTimeout(function(){ box.textContent=''; }, 6000);
}

async function loadTopics(){
  var box=document.getElementById('topicsList');
  var select=document.getElementById('topicSelect');
  box.innerHTML='<p class="text-slate-500">Caricamento…</p>';
  var topics=await api.topics();
  box.innerHTML=''; select.innerHTML='';
  topics.forEach(function(t){
    var item=el(
      '<div class="p-3 border rounded-xl flex items-center justify-between">'
        +'<div>'
          +'<div class="font-semibold">'+t.name+'</div>'
          +'<div class="text-xs text-slate-500">'+t.keywords.join(', ')+'</div>'
        +'</div>'
        +'<button data-id="'+t.id+'" class="crawlNow px-2 py-1 text-sm bg-emerald-700 text-white rounded-lg">Crawl</button>'
      +'</div>'
    );
    box.appendChild(item);
    var opt=document.createElement('option'); opt.value=t.id; opt.textContent=t.name; select.appendChild(opt);
  });
  Array.prototype.forEach.call(document.querySelectorAll('.crawlNow'), function(btn){
    btn.addEventListener('click', async function(){
      btn.disabled=true; btn.textContent='In corso…';
      var out = null;
      try {
        out = await api.crawl(btn.dataset.id);
        showMessage('crawlMessage', 'Nuovi contenuti: ' + (out.discovered || 0), 'success');
      } catch(err) {
        showMessage('crawlMessage', 'Errore durante il crawl', 'error');
      }
      btn.textContent='Crawl'; btn.disabled=false;
      renderResults(); loadAlerts();
    });
  });
}

async function renderResults(){
  var topicId=document.getElementById('topicSelect').value;
  var q=document.getElementById('searchInput').value;
  var sentiment=document.getElementById('sentimentFilter').value;
  if(!topicId) return;
  var data=await api.results(topicId,{q:q,sentiment:sentiment});
  var box=document.getElementById('results');
  if(!data.items.length){ box.innerHTML='<div class="p-6 text-slate-500">Nessun risultato</div>'; return; }
  box.innerHTML=data.items.map(function(item){
    var chip=item.sentiment==='negative'?'bg-red-100 text-red-700':(item.sentiment==='positive'?'bg-emerald-100 text-emerald-700':'bg-slate-100 text-slate-700');
    var stance=item.stance||'neutro';
    var ents=[]; try{ ents=JSON.parse(item.entities||'[]'); }catch(e){}
    return ''
      +'<article class="p-4 mb-3 border border-slate-200 rounded-xl shadow-sm hover:shadow-md transition">'
        +'<div class="flex items-start justify-between gap-3">'
          +'<div class="flex-1">'
            +'<a href="'+item.url+'" target="_blank" class="font-semibold hover:underline break-words">'+(item.title||item.url)+'</a>'
            +'<div class="text-sm text-slate-500 mt-1">'+(item.domain||'')+'</div>'
          +'</div>'
          +'<div class="flex items-center gap-2 flex-none">'
            +'<span class="chip '+chip+'">'+(item.sentiment||'?')+'</span>'
            +'<span class="chip bg-indigo-100 text-indigo-700">'+stance+'</span>'
          +'</div>'
        +'</div>'
        +'<p class="text-sm mt-3">'+(item.summary||'').replace(/</g,'&lt;')+'</p>'
        +(ents.length?'<div class="mt-2 text-xs text-slate-500">Entità: '+ents.join(', ')+'</div>':'')
        +'<div class="text-xs text-slate-400 mt-3">Pubblicato: '+(item.published_at||'—')+' · Scoperto: '+item.discovered_at+'</div>'
      +'</article>';
  }).join('');
}

async function loadAlerts(){
  var box=document.getElementById('alerts');
  var items=await api.alerts();
  if(!items.length){ box.innerHTML='<p class="text-slate-500">Nessun alert</p>'; return; }
  box.innerHTML='';
  items.forEach(function(a){
    var node=el(
      '<div class="p-3 border rounded-xl">'
        +'<div class="flex items-center justify-between">'
          +'<div class="font-semibold">'+a.type+'</div>'
          +'<button data-id="'+a.id+'" class="dismiss px-2 py-1 text-sm bg-slate-200 rounded-lg">Ok</button>'
        +'</div>'
        +'<div class="text-sm mt-1">'+a.message+'</div>'
        +'<div class="text-xs text-slate-500">'+a.created_at+'</div>'
      +'</div>'
    );
    box.appendChild(node);
  });
  Array.prototype.forEach.call(document.querySelectorAll('.dismiss'), function(btn){
    btn.addEventListener('click', async function(){ await api.dismissAlert(btn.dataset.id); loadAlerts(); });
  });
}

document.getElementById('crawlBtn').addEventListener('click', async function(){
  var topicId=document.getElementById('topicSelect').value;
  if(!topicId){
    showMessage('crawlMessage', 'Seleziona un topic per eseguire il crawl', 'error');
    return;
  }
  var btn=document.getElementById('crawlBtn');
  btn.disabled=true; btn.textContent='In corso…';
  var out = null;
  try {
    out = await api.crawl(topicId);
    showMessage('crawlMessage', 'Nuovi contenuti: ' + (out.discovered || 0), 'success');
  } catch(err) {
    showMessage('crawlMessage', 'Errore durante il crawl', 'error');
  }
  btn.textContent='Esegui crawl'; btn.disabled=false;
  renderResults(); loadAlerts();
});

document.getElementById('topicSelect').addEventListener('change', renderResults);
document.getElementById('sentimentFilter').addEventListener('change', renderResults);
document.getElementById('searchInput').addEventListener('input', function(){ clearTimeout(window.__srch); window.__srch=setTimeout(renderResults,350); });
document.getElementById('refreshAlerts').addEventListener('click', loadAlerts);

// Intercettiamo l'invio del form di creazione topic per inviare i dati via fetch
document.getElementById('topicForm').addEventListener('submit', async function(e){
  e.preventDefault();
  var form = e.target;
  // Costruiamo il payload a partire dai campi del form
  var body = {
    name: form.name.value,
    keywords: form.keywords.value.split(',').map(function(s){return s.trim();}).filter(Boolean),
    include_domains: form.include_domains.value ? form.include_domains.value.split(',').map(function(s){return s.trim();}).filter(Boolean) : [],
    exclude_domains: form.exclude_domains.value ? form.exclude_domains.value.split(',').map(function(s){return s.trim();}).filter(Boolean) : [],
    rss_feeds: form.rss_feeds.value.split(/\r?\n/).map(function(s){return s.trim();}).filter(Boolean),
    seeds: form.seeds.value.split(/\r?\n/).map(function(s){return s.trim();}).filter(Boolean),
    cron_expr: form.cron_expr.value && form.cron_expr.value.trim() !== '' ? form.cron_expr.value.trim() : '@hourly',
    is_active: true
  };
  try {
    var resp = await fetch('/api/topics', { method:'POST', headers:{'Content-Type':'application/json','Accept':'application/json'}, body: JSON.stringify(body) });
    if (!resp.ok) {
      var er = null;
      try { er = await resp.json(); } catch(ex){}
      showMessage('topicMessage', er && er.error ? er.error : 'Errore nella creazione del topic', 'error');
    } else {
      form.reset();
      showMessage('topicMessage', 'Topic creato con successo', 'success');
      await loadTopics();
      renderResults();
    }
  } catch(err) {
    showMessage('topicMessage', 'Errore di rete', 'error');
  }
});

(async function init(){ await loadTopics(); await loadAlerts(); setTimeout(renderResults,400); })();
</script>
</body>
</html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// ===== Cron
function scheduleJobs() {
  const topics = listTopics.all();
  topics.forEach(t => {
    if (!t.is_active) return;
    const expr = t.cron_expr || '@hourly';
    try {
      const cronExpr = expr === '@hourly' ? '0 * * * *' : (expr === '@daily' ? '0 3 * * *' : expr);
      cron.schedule(cronExpr, async () => {
        console.log(`[CRON] Crawling topic ${t.name}`);
        try { await crawlTopic(t.id, { maxItems: 40 }); } catch(e){ console.warn('Cron crawl error', e.message); }
      });
    } catch(e) { console.warn('Cron schedule error', t.name, e.message); }
  });
}
scheduleJobs();

// ===== Start
app.listen(PORT, () => {
  console.log(`Ascolto in rete avviato su ${BASE_URL}`);
  const count = db.prepare('SELECT COUNT(*) as n FROM topics').get().n;
  if (!count) {
    const demo = {
      id: uuidv4(),
      name: 'Demo – Notizie generiche',
      keywords: JSON.stringify(['roma','lazio']),
      include_domains: JSON.stringify([]),
      exclude_domains: JSON.stringify(['facebook.com','instagram.com']),
      rss_feeds: JSON.stringify([]),
      seeds: JSON.stringify([]),
      cron_expr: '@hourly',
      is_active: 1,
      created_at: nowISO()
    };
    insertTopic.run(demo);
    console.log('Creato topic demo. Aggiungi i tuoi feed/seeds dalla UI.');
  }
});
