/*
 * Портфель — прокси котировок (Cloudflare Worker).
 *
 * Зачем: сайты KASE, AIX, Нацбанка РК и API брокеров не отдают CORS-заголовки,
 * поэтому браузер не может запросить их напрямую. Прокси ходит в источники сам,
 * приводит ответы к одному формату и кэширует их на 2 минуты.
 * Прокси ничего не хранит и не пишет в журнал: он получает только тикеры,
 * без количеств и сумм.
 *
 * GET /quotes?symbols=kase:KCEL,aix:KAP  → { quotes: [{symbol, price, currency, date, time}], errors: {symbol: message} }
 * GET /fx                                → { rates: [{date, base, quote: 'KZT', rate}] }
 * GET /health                            → какие источники настроены
 * GET /raw?cmd=getStockQuotesJson&ticker=KCEL.KZ → ответ брокера как есть (только команды чтения котировок, для настройки)
 *
 * Переменные окружения (Settings → Variables; ключи — как Secret):
 *   ACCESS_TOKEN     — если задан, клиент должен прислать его в заголовке X-Access-Token
 *   ALLOWED_ORIGIN   — адрес приложения, например https://yeakhmetov.github.io (по умолчанию *)
 *   TN_API_KEY       — публичный ключ API Freedom / Tradernet (котировки KASE и AIX)
 *   TN_SECRET        — секретный ключ API Freedom / Tradernet
 *   TN_API_URL       — адрес API, по умолчанию https://tradernet.com/api (запрос идёт на <адрес>/<команда>)
 *   TN_SUFFIX_KASE   — суффикс тикеров KASE у брокера, по умолчанию .KZ
 *   TN_SUFFIX_AIX    — суффикс тикеров AIX у брокера, по умолчанию .AIX
 */

const CACHE_SECONDS = 120;

export default {
  async fetch(request, env) {
    return handle(request, env || {}, globalThis.fetch.bind(globalThis));
  }
};

export async function handle(request, env, fetchFn) {
  const url = new URL(request.url);
  const cors = {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'X-Access-Token',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
  const json = (body, status) => new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, cors)
  });

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
  if (env.ACCESS_TOKEN && request.headers.get('X-Access-Token') !== env.ACCESS_TOKEN) return json({ error: 'unauthorized' }, 401);

  try {
    if (url.pathname === '/health') {
      return json({ ok: true, sources: { kase: !!(env.TN_API_KEY && env.TN_SECRET), aix: !!(env.TN_API_KEY && env.TN_SECRET), nbk: true } });
    }
    if (url.pathname === '/fx') {
      return json(await cached('fx', () => nbkRates(fetchFn)));
    }
    if (url.pathname === '/quotes') {
      const symbols = (url.searchParams.get('symbols') || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 60);
      if (!symbols.length) return json({ error: 'symbols required' }, 400);
      const out = { quotes: [], errors: {} };
      await Promise.all(symbols.map(async sym => {
        try {
          const q = await cached('q:' + sym, () => quote(sym, env, fetchFn));
          if (q) out.quotes.push(q); else out.errors[sym] = 'not found';
        } catch (e) {
          out.errors[sym] = String(e && e.message || e);
        }
      }));
      return json(out);
    }
    if (url.pathname === '/raw') {
      // только команды чтения котировок — через прокси нельзя ни торговать, ни смотреть счёт
      const cmd = url.searchParams.get('cmd') || 'getStockQuotesJson';
      if (!RAW_CMDS[cmd]) return json({ error: 'command not allowed' }, 400);
      const ticker = (url.searchParams.get('ticker') || '').trim();
      if (!/^[A-Za-z0-9_.\-]{1,24}$/.test(ticker)) return json({ error: 'bad ticker' }, 400);
      if (!env.TN_API_KEY || !env.TN_SECRET) return json({ error: 'source not configured' }, 400);
      return json(await tradernet(cmd, RAW_CMDS[cmd](ticker), env, fetchFn));
    }
    return json({ error: 'not found' }, 404);
  } catch (e) {
    return json({ error: String(e && e.message || e) }, 502);
  }
}

/* ---------- кэш (Cloudflare Cache API; вне Cloudflare — без кэша) ---------- */

async function cached(key, fn) {
  const cache = typeof caches !== 'undefined' && caches.default;
  const req = new Request('https://portfolio-proxy.cache/' + encodeURIComponent(key));
  if (cache) {
    const hit = await cache.match(req);
    if (hit) return hit.json();
  }
  const value = await fn();
  if (cache && value) {
    await cache.put(req, new Response(JSON.stringify(value), { headers: { 'Cache-Control': 'max-age=' + CACHE_SECONDS } }));
  }
  return value;
}

/* ---------- KASE и AIX через API Freedom / Tradernet ---------- */

const RAW_CMDS = {
  getStockQuotesJson: t => ({ tickers: t }),
  getSecurityInfo: t => ({ ticker: t, sup: true })
};

async function quote(sym, env, fetchFn) {
  const i = sym.indexOf(':');
  const source = sym.slice(0, i), ticker = sym.slice(i + 1);
  if (i < 1 || !/^[A-Za-z0-9_.\-]{1,24}$/.test(ticker)) throw new Error('bad symbol');
  if (source !== 'kase' && source !== 'aix') throw new Error('unknown source');
  if (!env.TN_API_KEY || !env.TN_SECRET) throw new Error('source not configured');
  const suffix = source === 'kase' ? (env.TN_SUFFIX_KASE != null ? env.TN_SUFFIX_KASE : '.KZ') : (env.TN_SUFFIX_AIX != null ? env.TN_SUFFIX_AIX : '.AIX');
  // сначала тикер с суффиксом биржи, затем как есть
  const variants = ticker.includes('.') ? [ticker] : [ticker + suffix, ticker];
  let lastErr = null;
  for (const t of variants) {
    try {
      const d = await tradernet('getStockQuotesJson', { tickers: t }, env, fetchFn);
      const q = parseTradernetQuote(sym, d);
      if (q) return q;
    } catch (e) { lastErr = e; }
  }
  if (lastErr) throw lastErr;
  return null;
}

// ищет в ответе объект котировки: {result:{q:[…]}}, {q:[…]}, [ … ] или сам объект
function findQuote(d) {
  if (!d || typeof d !== 'object') return null;
  if (Array.isArray(d)) return d.find(x => x && typeof x === 'object' && (x.ltp != null || x.l != null || x.pp != null)) || null;
  if (d.ltp != null || d.l != null || (d.pp != null && d.c)) return d;
  for (const k of ['result', 'q', 'quotes', 'data']) {
    if (d[k] != null) { const r = findQuote(d[k]); if (r) return r; }
  }
  return null;
}

export function parseTradernetQuote(sym, d) {
  if (!d) throw new Error('empty response');
  if (d.errMsg || d.error) throw new Error(String(d.errMsg || d.error));
  const q = findQuote(d);
  if (!q) return null;
  const price = [q.ltp, q.l, q.lp, q.pp, q.close].map(Number).find(v => v > 0);
  if (!price) return null;
  const t = typeof q.ltt === 'string' ? q.ltt : '';
  return {
    symbol: sym,
    price,
    currency: normalizeCurrency(q.x_curr || q.curr || q.currency || null),
    date: /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : null,
    time: /\d{2}:\d{2}/.test(t) ? t.match(/(\d{2}:\d{2})/)[1] : null
  };
}

function normalizeCurrency(c) {
  if (!c) return null;
  c = String(c).toUpperCase();
  return c === 'RUR' || c === 'SUR' ? 'RUB' : c;
}

export async function hmacSha256Hex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// запрос к API Tradernet, протокол v3 (как в официальном tradernet-sdk):
// POST <адрес>/<команда>, тело — JSON параметров без пробелов,
// подпись HMAC-SHA256 от «тело + время в секундах» секретным ключом
export async function tradernet(cmd, params, env, fetchFn) {
  const base = (env.TN_API_URL || 'https://tradernet.com/api').replace(/\/+$/, '');
  const body = JSON.stringify(params || {});
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = await hmacSha256Hex(env.TN_SECRET, body + ts);
  const r = await fetchFn(base + '/' + cmd, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-NtApi-PublicKey': env.TN_API_KEY, 'X-NtApi-Timestamp': ts, 'X-NtApi-Sig': sig },
    body
  });
  const text = await r.text();
  let d;
  try { d = JSON.parse(text); } catch (e) { throw new Error('broker API HTTP ' + r.status + (text ? ': ' + text.slice(0, 120) : '')); }
  if (!r.ok && !(d && (d.errMsg || d.error))) throw new Error('broker API HTTP ' + r.status);
  return d;
}

/* ---------- Национальный банк РК ---------- */

async function nbkRates(fetchFn) {
  const r = await fetchFn('https://nationalbank.kz/rss/rates_all.xml', { headers: { 'Accept': 'application/xml' } });
  if (!r.ok) throw new Error('nationalbank.kz HTTP ' + r.status);
  return { rates: parseNbkRss(await r.text()) };
}

// RSS Нацбанка: <item><title>USD</title><pubDate>28.09.26</pubDate><description>480.12</description><quant>1</quant></item>
export function parseNbkRss(xml) {
  const tag = (s, name) => { const m = new RegExp('<' + name + '>\\s*([\\s\\S]*?)\\s*</' + name + '>').exec(s); return m ? m[1].trim() : ''; };
  const out = [];
  const items = String(xml).match(/<item>[\s\S]*?<\/item>/g) || [];
  items.forEach(it => {
    const code = tag(it, 'title').toUpperCase();
    const value = Number(tag(it, 'description').replace(',', '.'));
    const quant = Number(tag(it, 'quant') || 1) || 1;
    const dm = /^(\d{2})\.(\d{2})\.(\d{2,4})$/.exec(tag(it, 'pubDate'));
    if (!/^[A-Z]{3}$/.test(code) || !(value > 0) || !dm) return;
    const year = dm[3].length === 2 ? '20' + dm[3] : dm[3];
    out.push({ date: year + '-' + dm[2] + '-' + dm[1], base: code, quote: 'KZT', rate: +(value / quant).toFixed(6) });
  });
  return out;
}
