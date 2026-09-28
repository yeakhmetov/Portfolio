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
 *
 * Переменные окружения (Settings → Variables; ключи — как Secret):
 *   ACCESS_TOKEN     — если задан, клиент должен прислать его в заголовке X-Access-Token
 *   ALLOWED_ORIGIN   — адрес приложения, например https://yeakhmetov.github.io (по умолчанию *)
 *   TN_API_KEY       — публичный ключ API Freedom / Tradernet (котировки KASE и AIX)
 *   TN_SECRET        — секретный ключ API Freedom / Tradernet
 *   TN_API_URL       — адрес API, по умолчанию https://tradernet.com/api
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

async function quote(sym, env, fetchFn) {
  const [source, ticker] = sym.split(':');
  if (!ticker || !/^[A-Z0-9_.\-]{1,20}$/.test(ticker)) throw new Error('bad symbol');
  if (source !== 'kase' && source !== 'aix') throw new Error('unknown source');
  if (!env.TN_API_KEY || !env.TN_SECRET) throw new Error('source not configured');
  const suffix = source === 'kase' ? (env.TN_SUFFIX_KASE != null ? env.TN_SUFFIX_KASE : '.KZ') : (env.TN_SUFFIX_AIX != null ? env.TN_SUFFIX_AIX : '.AIX');
  const brokerTicker = ticker.includes('.') ? ticker : ticker + suffix;
  const d = await tradernet('quotes.getInfo', { ticker: brokerTicker }, env, fetchFn);
  return parseTradernetQuote(sym, d);
}

export function parseTradernetQuote(sym, d) {
  if (!d || d.error || d.errMsg) throw new Error((d && (d.errMsg || d.error)) || 'empty response');
  const price = Number(d.l != null ? d.l : d.pp);
  if (!(price > 0)) return null;
  const t = typeof d.ltt === 'string' ? d.ltt : '';
  return {
    symbol: sym,
    price,
    currency: normalizeCurrency(d.curr || d.x_curr || null),
    date: /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : null,
    time: /T?\d{2}:\d{2}/.test(t) ? t.match(/(\d{2}:\d{2})/)[1] : null
  };
}

function normalizeCurrency(c) {
  if (!c) return null;
  c = String(c).toUpperCase();
  return c === 'RUR' || c === 'SUR' ? 'RUB' : c;
}

// строка для подписи: ключи по алфавиту, «ключ=значение» через &, вложенные объекты — рекурсивно
export function preSign(data) {
  return Object.keys(data).sort().map(k => {
    const v = data[k];
    return v !== null && typeof v === 'object' ? k + '=' + preSign(v) : k + '=' + v;
  }).join('&');
}

export async function hmacSha256Hex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// запрос к API Tradernet, протокол v2: POST /v2/cmd/<cmd>, подпись HMAC-SHA256 в заголовке X-NtApi-Sig
async function tradernet(cmd, params, env, fetchFn) {
  const base = (env.TN_API_URL || 'https://tradernet.com/api').replace(/\/+$/, '');
  const payload = { apiKey: env.TN_API_KEY, cmd, nonce: Date.now() * 10, params };
  const sig = await hmacSha256Hex(env.TN_SECRET, preSign(payload));
  const body = new URLSearchParams();
  body.set('apiKey', payload.apiKey);
  body.set('cmd', cmd);
  body.set('nonce', String(payload.nonce));
  Object.keys(params).forEach(k => body.set('params[' + k + ']', params[k]));
  const r = await fetchFn(base + '/v2/cmd/' + cmd, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-NtApi-Sig': sig },
    body: body.toString()
  });
  if (!r.ok) throw new Error('broker API HTTP ' + r.status);
  return r.json();
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
