// Тесты прокси без сети: node proxy/test.mjs
import { handle, preSign, hmacSha256Hex, parseNbkRss, parseTradernetQuote } from './worker.js';
import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';

const results = [];
async function test(name, fn) {
  try { await fn(); results.push([true, name]); } catch (e) { results.push([false, name, e.message]); }
}

await test('Строка подписи: ключи по алфавиту, вложенные параметры', () => {
  assert.equal(preSign({ nonce: 5, cmd: 'quotes.getInfo', apiKey: 'K', params: { ticker: 'KCEL.KZ' } }),
    'apiKey=K&cmd=quotes.getInfo&nonce=5&params=ticker=KCEL.KZ');
});

await test('Подпись HMAC-SHA256 совпадает с эталонной', async () => {
  const msg = 'apiKey=K&cmd=quotes.getInfo&nonce=5&params=ticker=KCEL.KZ';
  assert.equal(await hmacSha256Hex('s3cret', msg), createHmac('sha256', 's3cret').update(msg).digest('hex'));
});

await test('Разбор RSS Нацбанка', () => {
  const xml = `<rss><channel>
    <item><title>USD</title><pubDate>28.09.26</pubDate><description>480.12</description><quant>1</quant></item>
    <item><title>RUB</title><pubDate>28.09.26</pubDate><description>5.61</description><quant>1</quant></item>
    <item><title>JPY</title><pubDate>28.09.26</pubDate><description>330.5</description><quant>100</quant></item>
    <item><title>мусор</title><pubDate>x</pubDate><description>0</description></item>
  </channel></rss>`;
  const r = parseNbkRss(xml);
  assert.equal(r.length, 3);
  assert.deepEqual(r[0], { date: '2026-09-28', base: 'USD', quote: 'KZT', rate: 480.12 });
  assert.equal(r[2].rate, 3.305, 'курс за 100 иен');
});

await test('Разбор котировки брокера', () => {
  const q = parseTradernetQuote('kase:KCEL', { c: 'KCEL.KZ', l: 2150.5, curr: 'KZT', ltt: '2026-09-28T12:31:05' });
  assert.deepEqual(q, { symbol: 'kase:KCEL', price: 2150.5, currency: 'KZT', date: '2026-09-28', time: '12:31' });
  assert.equal(parseTradernetQuote('kase:X', { c: 'X', l: 0 }), null);
  assert.throws(() => parseTradernetQuote('kase:X', { errMsg: 'Bad sign' }), /Bad sign/);
});

const env = { TN_API_KEY: 'K', TN_SECRET: 's3cret', ACCESS_TOKEN: 'tok', ALLOWED_ORIGIN: 'https://app.example' };
const req = (path, headers) => new Request('https://proxy.example' + path, { headers: headers || { 'X-Access-Token': 'tok' } });

await test('Доступ по токену и CORS', async () => {
  const r1 = await handle(req('/health', {}), env, () => { throw new Error('no net'); });
  assert.equal(r1.status, 401);
  const r2 = await handle(new Request('https://proxy.example/quotes', { method: 'OPTIONS' }), env, null);
  assert.equal(r2.status, 204);
  assert.equal(r2.headers.get('Access-Control-Allow-Origin'), 'https://app.example');
  assert.match(r2.headers.get('Access-Control-Allow-Headers'), /X-Access-Token/);
});

await test('/quotes: запрос к брокеру с подписью, ошибки по тикерам', async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    const p = new URLSearchParams(init.body);
    const payload = { apiKey: p.get('apiKey'), cmd: p.get('cmd'), nonce: p.get('nonce'), params: { ticker: p.get('params[ticker]') } };
    const expected = createHmac('sha256', 's3cret').update(preSign(payload)).digest('hex');
    if (init.headers['X-NtApi-Sig'] !== expected) return new Response(JSON.stringify({ errMsg: 'Bad sign' }));
    const t = p.get('params[ticker]');
    if (t === 'KCEL.KZ') return new Response(JSON.stringify({ c: t, l: 2150.5, curr: 'KZT', ltt: '2026-09-28T12:31:00' }));
    if (t === 'KAP.AIX') return new Response(JSON.stringify({ c: t, l: 38.2, curr: 'USD', ltt: '2026-09-28T12:30:00' }));
    return new Response(JSON.stringify({ c: t }));
  };
  const r = await handle(req('/quotes?symbols=kase:KCEL,aix:KAP,kase:NOPE,moex:SBER'), env, fetchFn);
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.equal(body.quotes.length, 2);
  assert.equal(body.quotes.find(q => q.symbol === 'aix:KAP').currency, 'USD');
  assert.equal(body.errors['kase:NOPE'], 'not found');
  assert.equal(body.errors['moex:SBER'], 'unknown source');
  assert.ok(calls[0].url.endsWith('/v2/cmd/quotes.getInfo'));
});

await test('/quotes без ключей брокера — понятная ошибка', async () => {
  const r = await handle(req('/quotes?symbols=kase:KCEL', {}), {}, async () => { throw new Error('no net'); });
  assert.equal((await r.json()).errors['kase:KCEL'], 'source not configured');
});

await test('/quotes отклоняет подозрительные тикеры', async () => {
  const r = await handle(req('/quotes?symbols=kase:..%2F..%2Fetc', {}), { TN_API_KEY: 'K', TN_SECRET: 's' }, async () => { throw new Error('должно быть отклонено до запроса'); });
  assert.equal((await r.json()).errors['kase:../../etc'], 'bad symbol');
});

await test('/fx: курсы Нацбанка', async () => {
  const fetchFn = async url => {
    assert.equal(url, 'https://nationalbank.kz/rss/rates_all.xml');
    return new Response('<rss><item><title>USD</title><pubDate>28.09.26</pubDate><description>480.12</description><quant>1</quant></item></rss>');
  };
  const body = await (await handle(req('/fx'), env, fetchFn)).json();
  assert.equal(body.rates[0].rate, 480.12);
});

for (const [ok, name, err] of results) console.log((ok ? '✓ ' : '✗ ') + name + (ok ? '' : '\n    ' + err));
const failed = results.filter(r => !r[0]).length;
console.log('\n' + (results.length - failed) + ' из ' + results.length + ' тестов прокси пройдено');
if (failed) process.exitCode = 1;
