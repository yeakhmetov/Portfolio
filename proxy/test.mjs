// Тесты прокси без сети: node proxy/test.mjs
import { handle, hmacSha256Hex, parseNbkRss, parseTradernetQuote } from './worker.js';
import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';

const results = [];
async function test(name, fn) {
  try { await fn(); results.push([true, name]); } catch (e) { results.push([false, name, e.message]); }
}

await test('Подпись HMAC-SHA256 совпадает с эталонной', async () => {
  const msg = '{"tickers":"KCEL.KZ"}1790000000';
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
  const q = parseTradernetQuote('kase:KCEL', { result: { q: [{ c: 'KCEL.KZ', ltp: 2150.5, x_curr: 'KZT', ltt: '2026-09-28T12:31:05' }] } });
  assert.deepEqual(q, { symbol: 'kase:KCEL', price: 2150.5, currency: 'KZT', date: '2026-09-28', time: '12:31' });
  assert.equal(parseTradernetQuote('kase:X', { q: [{ c: 'X', ltp: 0, pp: 512 }] }).price, 512, 'без сделок — цена закрытия');
  assert.equal(parseTradernetQuote('kase:X', { c: 'X', l: 7, curr: 'USD' }).price, 7);
  assert.equal(parseTradernetQuote('kase:X', { result: { q: [] } }), null);
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

await test('/quotes: запрос к брокеру по протоколу v3, ошибки по тикерам', async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    const h = init.headers;
    const expected = createHmac('sha256', 's3cret').update(init.body + h['X-NtApi-Timestamp']).digest('hex');
    if (h['X-NtApi-Sig'] !== expected || h['X-NtApi-PublicKey'] !== 'K') return new Response(JSON.stringify({ errMsg: 'Bad sign' }));
    const t = JSON.parse(init.body).tickers;
    if (t === 'KCEL.KZ') return new Response(JSON.stringify({ result: { q: [{ c: t, ltp: 2150.5, x_curr: 'KZT', ltt: '2026-09-28T12:31:00' }] } }));
    if (t === 'KAP.AIX') return new Response(JSON.stringify({ result: { q: [{ c: t, ltp: 38.2, x_curr: 'USD' }] } }));
    if (t === 'KZTKp') return new Response(JSON.stringify({ result: { q: [{ c: t, ltp: 900, x_curr: 'KZT' }] } }));
    return new Response(JSON.stringify({ result: { q: [] } }));
  };
  const r = await handle(req('/quotes?symbols=kase:KCEL,aix:KAP,kase:KZTKp,kase:NOPE,moex:SBER'), env, fetchFn);
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.equal(body.quotes.length, 3);
  assert.equal(body.quotes.find(q => q.symbol === 'aix:KAP').currency, 'USD');
  assert.equal(body.quotes.find(q => q.symbol === 'kase:KZTKp').price, 900, 'запасной вариант — тикер без суффикса, регистр сохраняется');
  assert.equal(body.errors['kase:NOPE'], 'not found');
  assert.equal(body.errors['moex:SBER'], 'unknown source');
  assert.equal(calls[0].url, 'https://tradernet.com/api/getStockQuotesJson');
  assert.equal(calls[0].init.method, 'POST');
});

await test('/raw разрешает только команды котировок', async () => {
  const r1 = await handle(req('/raw?cmd=putTradeOrder&ticker=KCEL.KZ'), env, async () => { throw new Error('не должно дойти'); });
  assert.equal(r1.status, 400);
  const r2 = await handle(req('/raw?cmd=getSecurityInfo&ticker=KCEL.KZ'), env, async (url, init) => new Response(JSON.stringify({ url, body: init.body })));
  const b2 = await r2.json();
  assert.equal(b2.url, 'https://tradernet.com/api/getSecurityInfo');
  assert.deepEqual(JSON.parse(b2.body), { ticker: 'KCEL.KZ', sup: true });
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
