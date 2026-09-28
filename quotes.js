/*
 * Портфель — котировки и курсы валют.
 * Адаптеры источников с единым интерфейсом, выбор источника по бирже актива,
 * запасные источники, расписание торгов. Сеть передаётся снаружи (fetchJson),
 * поэтому логику можно проверить тестами без интернета.
 *
 *   KASE, AIX, Нацбанк РК — через прокси (сайты бирж не отдают CORS-заголовки), см. proxy/
 *   MOEX ISS, CoinGecko, Twelve Data, open.er-api.com — напрямую из браузера
 */
(function (root) {
  'use strict';

  /* ---------- маршруты ---------- */

  // порядок источников для биржи актива: первый — основной, дальше — запасные
  var ROUTES = {
    KASE: ['kase', 'aix', 'global'],
    AIX: ['aix', 'kase', 'global'],
    MOEX: ['moex'],
    NYSE: ['global', 'kase'],
    NASDAQ: ['global', 'kase'],
    LSE: ['global'],
    CRYPTO: ['crypto']
  };

  var SOURCE_LABELS = { kase: 'KASE', aix: 'AIX', moex: 'MOEX', global: 'Twelve Data', crypto: 'CoinGecko', nbk: 'Нацбанк РК', er: 'open.er-api', manual: 'Вручную', demo: 'Демо' };

  var COINS = {
    BTC: 'bitcoin', ETH: 'ethereum', USDT: 'tether', USDC: 'usd-coin', BNB: 'binancecoin', SOL: 'solana', XRP: 'ripple',
    TON: 'the-open-network', ADA: 'cardano', DOGE: 'dogecoin', TRX: 'tron', DOT: 'polkadot', LTC: 'litecoin',
    AVAX: 'avalanche-2', LINK: 'chainlink', MATIC: 'matic-network', ATOM: 'cosmos', NEAR: 'near'
  };

  function routeFor(asset) {
    if (!asset || asset.quoteSource === 'manual') return [];
    if (asset.class === 'deposit' || asset.class === 'currency') return [];
    if (asset.class === 'crypto' || asset.exchange === 'CRYPTO') return ['crypto'];
    return ROUTES[asset.exchange] || [];
  }

  // тикер для запроса к источнику: своё обозначение актива (quoteSymbol) важнее тикера
  function symbolFor(asset, source) {
    var t = (asset.quoteSymbol || asset.ticker || '').trim();
    if (source === 'crypto') return asset.quoteSymbol ? t.toLowerCase() : (COINS[t.toUpperCase()] || t.toLowerCase());
    return t.toUpperCase();
  }

  /* ---------- расписание торгов ---------- */

  // основная сессия в минутах от полуночи UTC, пн–пт
  var SESSIONS = {
    KASE: [390, 720],     // 11:30–17:00 (UTC+5)
    AIX: [390, 720],      // 11:30–17:00 (UTC+5)
    MOEX: [420, 1250],    // 10:00–23:50 МСК, с вечерней сессией
    NYSE: [810, 1260],    // 9:30–16:00 Нью-Йорк, с запасом на летнее время
    NASDAQ: [810, 1260],
    LSE: [420, 990]       // 8:00–16:30 Лондон, с запасом
  };
  var DAY = 86400000, MIN = 60000;

  function exchangeOf(asset) { return asset.class === 'crypto' ? 'CRYPTO' : asset.exchange; }

  function isOpen(exchange, now) {
    var s = SESSIONS[exchange];
    if (!s) return true; // крипта и неизвестные рынки — считаем открытыми
    var d = new Date(now), dow = d.getUTCDay();
    if (dow === 0 || dow === 6) return false;
    var m = d.getUTCHours() * 60 + d.getUTCMinutes();
    return m >= s[0] && m < s[1];
  }

  // время окончания последней завершённой сессии (мс) или null, если рынок открыт или без расписания
  function lastClose(exchange, now) {
    var s = SESSIONS[exchange];
    if (!s || isOpen(exchange, now)) return null;
    var d0 = new Date(now);
    var midnight = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), d0.getUTCDate());
    for (var i = 0; i < 8; i++) {
      var day = midnight - i * DAY, dow = new Date(day).getUTCDay();
      if (dow === 0 || dow === 6) continue;
      var end = day + s[1] * MIN;
      if (end <= now) return end;
    }
    return null;
  }

  // нужно ли запрашивать цену: нет цены, устарела при открытом рынке,
  // или после закрытия ещё не получена цена закрытия (с запасом 20 мин на задержку данных)
  function needsRefresh(asset, rec, now, intervalMin) {
    if (!rec || !rec.fetchedAt) return true;
    var fetched = Date.parse(rec.fetchedAt);
    if (!isFinite(fetched)) return true;
    var ex = exchangeOf(asset);
    if (!SESSIONS[ex] || isOpen(ex, now)) return now - fetched >= intervalMin * MIN;
    var lc = lastClose(ex, now);
    return lc != null && fetched < lc + 20 * MIN;
  }

  // «устарела»: цене больше суток, а рынок за это время торговался
  function isStale(asset, rec, now) {
    if (!rec) return false;
    var t = Date.parse(rec.fetchedAt || (rec.date + 'T12:00:00Z'));
    if (!isFinite(t)) return false;
    var ex = exchangeOf(asset);
    if (!SESSIONS[ex]) return now - t > DAY;
    var lc = lastClose(ex, now);
    var ref = lc == null ? now : lc;
    return ref - t > DAY;
  }

  /* ---------- разбор ответов ---------- */

  function num(x) { var v = typeof x === 'string' ? Number(x.replace(',', '.')) : x; return typeof v === 'number' && isFinite(v) && v > 0 ? v : null; }

  // MOEX ISS: {marketdata:{columns,data}, securities:{columns,data}}
  var MOEX_BOARDS = ['TQBR', 'TQTF', 'TQCB', 'TQOB', 'TQIR', 'FQBR', 'TQPI', 'TQTD'];
  function parseMoex(json) {
    var out = {};
    function table(t) {
      if (!t || !t.columns) return [];
      return t.data.map(function (row) { var o = {}; t.columns.forEach(function (c, i) { o[c] = row[i]; }); return o; });
    }
    var md = table(json.marketdata), sec = table(json.securities);
    var secBy = {};
    sec.forEach(function (s) { secBy[s.SECID + '|' + s.BOARDID] = s; });
    md.forEach(function (m) {
      var s = secBy[m.SECID + '|' + m.BOARDID] || {};
      var price = num(m.LAST) || num(m.LCURRENTPRICE) || num(m.MARKETPRICE) || num(s.PREVPRICE) || num(s.PREVLEGALCLOSEPRICE);
      if (!price) return;
      var rank = MOEX_BOARDS.indexOf(m.BOARDID); if (rank < 0) rank = 99;
      var prev = out[m.SECID];
      if (prev && prev._rank <= rank) return;
      var cur = s.CURRENCYID === 'SUR' || !s.CURRENCYID ? 'RUB' : s.CURRENCYID;
      var ts = m.SYSTIME || m.UPDATETIME || '';
      out[m.SECID] = { price: price, currency: cur, date: /^\d{4}-\d{2}-\d{2}/.test(ts) ? ts.slice(0, 10) : null, time: /\d{2}:\d{2}/.test(ts) ? ts.match(/\d{2}:\d{2}/)[0] : null, _rank: rank };
    });
    Object.keys(out).forEach(function (k) { delete out[k]._rank; });
    return out;
  }

  // CoinGecko simple/price: {bitcoin:{usd:1, last_updated_at:…}}
  function parseCoinGecko(json, ids, cur) {
    var out = {}, c = cur.toLowerCase();
    ids.forEach(function (id) {
      var r = json && json[id];
      var p = r && num(r[c]);
      if (!p) return;
      var t = r.last_updated_at ? new Date(r.last_updated_at * 1000).toISOString() : null;
      out[id] = { price: p, currency: cur.toUpperCase(), date: t ? t.slice(0, 10) : null, time: t ? t.slice(11, 16) : null };
    });
    return out;
  }

  // Twelve Data /price: один тикер → {price:"1"}, несколько → {AAPL:{price:"1"}}; ошибка → {code, message}
  function parseTwelveData(json, symbols) {
    var out = {};
    if (!json) return out;
    if (json.status === 'error' && json.message) throw new Error(json.message);
    if (symbols.length === 1 && json.price != null) {
      var p = num(json.price); if (p) out[symbols[0]] = { price: p };
      return out;
    }
    symbols.forEach(function (s) { var r = json[s]; var p = r && num(r.price); if (p) out[s] = { price: p }; });
    return out;
  }

  // ответ прокси: {quotes:[{symbol:'kase:KCEL', price, currency, date, time}], errors:{…}}
  function parseProxyQuotes(json) {
    var out = {};
    ((json && json.quotes) || []).forEach(function (q) {
      var p = num(q.price);
      if (p && q.symbol) out[q.symbol] = { price: p, currency: q.currency || null, date: q.date || null, time: q.time || null };
    });
    return out;
  }

  // open.er-api.com/v6/latest/USD → курсы к тенге: [{date, base, quote:'KZT', rate}]
  function parseErApi(json, currencies) {
    if (!json || json.result !== 'success' || !json.rates || !json.rates.KZT) throw new Error('Неверный ответ сервиса курсов');
    var date = json.time_last_update_unix ? new Date(json.time_last_update_unix * 1000).toISOString().slice(0, 10) : null;
    var kzt = json.rates.KZT, base = json.base_code || 'USD';
    return currencies.filter(function (c) { return c !== 'KZT' && (c === base || json.rates[c]); }).map(function (c) {
      var perBase = c === base ? 1 : json.rates[c];
      return { date: date, base: c, quote: 'KZT', rate: +(kzt / perBase).toFixed(6) };
    });
  }

  /* ---------- адаптеры ---------- */

  function proxyUrl(settings, path) {
    var u = (settings.proxyUrl || '').trim().replace(/\/+$/, '');
    return u ? u + path : null;
  }
  function proxyHeaders(settings) {
    return settings.proxyToken ? { 'X-Access-Token': settings.proxyToken } : {};
  }
  function err(code, message) { var e = new Error(message); e.code = code; return e; }

  // каждый адаптер: (assets, ctx) → Promise<{ assetId: {price, currency, date, time} }>
  var ADAPTERS = {
    kase: function (assets, ctx) { return viaProxy('kase', assets, ctx); },
    aix: function (assets, ctx) { return viaProxy('aix', assets, ctx); },

    moex: function (assets, ctx) {
      var bonds = assets.filter(function (a) { return a.class === 'bond'; });
      var shares = assets.filter(function (a) { return a.class !== 'bond'; });
      var jobs = [];
      [['shares', shares], ['bonds', bonds]].forEach(function (g) {
        if (!g[1].length) return;
        var syms = g[1].map(function (a) { return symbolFor(a, 'moex'); });
        var url = 'https://iss.moex.com/iss/engines/stock/markets/' + g[0] + '/securities.json?iss.meta=off&iss.only=marketdata,securities' +
          '&securities=' + encodeURIComponent(syms.join(',')) +
          '&marketdata.columns=SECID,BOARDID,LAST,LCURRENTPRICE,MARKETPRICE,UPDATETIME,SYSTIME' +
          '&securities.columns=SECID,BOARDID,PREVPRICE,PREVLEGALCLOSEPRICE,CURRENCYID';
        jobs.push(ctx.fetchJson(url).then(function (json) {
          var parsed = parseMoex(json), out = {};
          g[1].forEach(function (a) { var q = parsed[symbolFor(a, 'moex')]; if (q) out[a.id] = q; });
          return out;
        }));
      });
      return Promise.all(jobs).then(function (rs) { return Object.assign.apply(null, [{}].concat(rs)); });
    },

    crypto: function (assets, ctx) {
      var byCur = {};
      assets.forEach(function (a) { (byCur[a.currency] = byCur[a.currency] || []).push(a); });
      return Promise.all(Object.keys(byCur).map(function (cur) {
        var list = byCur[cur], ids = list.map(function (a) { return symbolFor(a, 'crypto'); });
        var url = 'https://api.coingecko.com/api/v3/simple/price?ids=' + encodeURIComponent(ids.join(',')) +
          '&vs_currencies=' + cur.toLowerCase() + '&include_last_updated_at=true';
        return ctx.fetchJson(url).then(function (json) {
          var parsed = parseCoinGecko(json, ids, cur), out = {};
          list.forEach(function (a) { var q = parsed[symbolFor(a, 'crypto')]; if (q) out[a.id] = q; });
          return out;
        });
      })).then(function (rs) { return Object.assign.apply(null, [{}].concat(rs)); });
    },

    global: function (assets, ctx) {
      var key = (ctx.settings.twelveDataKey || '').trim();
      if (!key) return Promise.reject(err('no-key', 'не указан ключ Twelve Data'));
      var syms = assets.map(function (a) { return symbolFor(a, 'global'); });
      var url = 'https://api.twelvedata.com/price?symbol=' + encodeURIComponent(syms.join(',')) + '&apikey=' + encodeURIComponent(key);
      return ctx.fetchJson(url).then(function (json) {
        var parsed = parseTwelveData(json, syms), out = {};
        // Twelve Data не сообщает валюту; для бирж США и Лондона считаем её валютой актива
        assets.forEach(function (a) { var q = parsed[symbolFor(a, 'global')]; if (q) out[a.id] = { price: q.price, currency: null, date: null, time: null }; });
        return out;
      });
    }
  };

  function viaProxy(source, assets, ctx) {
    var syms = assets.map(function (a) { return source + ':' + symbolFor(a, source); });
    var url = proxyUrl(ctx.settings, '/quotes?symbols=' + encodeURIComponent(syms.join(',')));
    if (!url) return Promise.reject(err('no-proxy', 'не настроен прокси'));
    return ctx.fetchJson(url, { headers: proxyHeaders(ctx.settings) }).then(function (json) {
      var parsed = parseProxyQuotes(json), out = {};
      assets.forEach(function (a) { var q = parsed[source + ':' + symbolFor(a, source)]; if (q) out[a.id] = q; });
      return out;
    });
  }

  /*
   * Обновление котировок.
   * opts: { assets, latest: {assetId: priceRec}, settings, fetchJson, now (мс), fxRate(from, to), force }
   * Возвращает { updates: [{assetId, price, date, time, source, fetchedAt}], failures: {source: {code, message, tickers}}, requested }
   */
  function refreshQuotes(opts) {
    var now = opts.now || Date.now();
    var settings = opts.settings || {};
    var interval = settings.quoteRefreshMinutes || 15;
    var nowIso = new Date(now).toISOString();
    var due = (opts.assets || []).filter(function (a) {
      return routeFor(a).length && (opts.force || needsRefresh(a, opts.latest && opts.latest[a.id], now, interval));
    });
    var updates = [], failures = {};
    var ctx = { settings: settings, fetchJson: opts.fetchJson };

    function round(pending, step) {
      if (!pending.length) return Promise.resolve();
      var groups = {}, rest = [];
      pending.forEach(function (a) {
        var src = routeFor(a)[step];
        if (!src) return;
        (groups[src] = groups[src] || []).push(a);
      });
      var srcs = Object.keys(groups);
      if (!srcs.length) return Promise.resolve();
      return Promise.all(srcs.map(function (src) {
        var list = groups[src];
        return Promise.resolve().then(function () { return ADAPTERS[src](list, ctx); }).then(function (got) {
          list.forEach(function (a) {
            var q = got[a.id];
            var price = q ? convert(q, a) : null;
            if (price) updates.push({ assetId: a.id, price: price, date: q.date || nowIso.slice(0, 10), time: q.time || null, source: src, fetchedAt: nowIso });
            else rest.push(a);
          });
          var miss = list.filter(function (a) { return !got[a.id]; });
          if (miss.length) addFailure(src, 'not-found', 'нет котировки', miss);
        }, function (e) {
          addFailure(src, e && e.code || 'error', e && e.message || String(e), list);
          rest.push.apply(rest, list);
        });
      })).then(function () { return round(rest, step + 1); });
    }
    function convert(q, a) {
      var p = q.price;
      if (!q.currency || q.currency === a.currency || a.class === 'bond') return +p.toFixed(8);
      var r = opts.fxRate ? opts.fxRate(q.currency, a.currency) : null;
      return r ? +(p * r).toFixed(8) : null;
    }
    function addFailure(src, code, message, list) {
      var f = failures[src] = failures[src] || { code: code, message: message, tickers: [] };
      list.forEach(function (a) { if (f.tickers.indexOf(a.ticker) < 0) f.tickers.push(a.ticker); });
    }
    return round(due, 0).then(function () {
      // тикер, который нашёлся в запасном источнике, не считается сбоем
      var got = {}; updates.forEach(function (u) { got[u.assetId] = true; });
      Object.keys(failures).forEach(function (s) {
        failures[s].tickers = failures[s].tickers.filter(function (t) {
          return !(opts.assets || []).some(function (a) { return a.ticker === t && got[a.id]; });
        });
        if (!failures[s].tickers.length) delete failures[s];
      });
      return { updates: updates, failures: failures, requested: due.length };
    });
  }

  /*
   * Курсы валют к тенге: Нацбанк РК через прокси, запасной источник — open.er-api.com.
   * Возвращает Promise<{ rates: [{date, base, quote, rate}], source }>
   */
  function refreshFx(opts) {
    var settings = opts.settings || {}, currencies = opts.currencies || ['USD', 'EUR', 'RUB'];
    var url = proxyUrl(settings, '/fx');
    var viaNbk = url ? opts.fetchJson(url, { headers: proxyHeaders(settings) }).then(function (json) {
      var rates = ((json && json.rates) || []).filter(function (r) { return currencies.indexOf(r.base) >= 0 && num(r.rate); });
      if (!rates.length) throw new Error('пустой ответ Нацбанка');
      return { rates: rates, source: 'nbk' };
    }) : Promise.reject(err('no-proxy', 'не настроен прокси'));
    return viaNbk.catch(function () {
      return opts.fetchJson('https://open.er-api.com/v6/latest/USD').then(function (json) {
        return { rates: parseErApi(json, currencies), source: 'er' };
      });
    });
  }

  var api = {
    ROUTES: ROUTES,
    SOURCE_LABELS: SOURCE_LABELS,
    COINS: COINS,
    routeFor: routeFor,
    symbolFor: symbolFor,
    isOpen: isOpen,
    lastClose: lastClose,
    needsRefresh: needsRefresh,
    isStale: isStale,
    parseMoex: parseMoex,
    parseCoinGecko: parseCoinGecko,
    parseTwelveData: parseTwelveData,
    parseProxyQuotes: parseProxyQuotes,
    parseErApi: parseErApi,
    refreshQuotes: refreshQuotes,
    refreshFx: refreshFx
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PortfolioQuotes = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
