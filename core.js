/*
 * Портфель — ядро расчётов. Чистые функции без DOM и хранилища,
 * чтобы их можно было проверить тестами и в браузере (tests.html), и в Node (node tests.js).
 *
 * Соглашения:
 *  - Суммы денег — целые числа в минимальных единицах валюты (тиыны, центы, копейки).
 *  - Количество бумаг — целое число, умноженное на QTY_SCALE (1e8), т.е. до 8 знаков после запятой.
 *  - Цена — число в основных единицах валюты за 1 шт. (для облигаций — % от номинала).
 *    Цена — справочная величина; итоговые суммы всегда целые.
 *  - Даты — строки 'YYYY-MM-DD'.
 */
(function (root) {
  'use strict';

  var QTY_SCALE = 100000000; // 1e8
  var QTY_DECIMALS = 8;

  /* ---------- числа ---------- */

  // round(a * b / c) без потери точности на больших числах
  function mulDivRound(a, b, c) {
    if (c === 0) throw new Error('division by zero');
    var A = BigInt(a), B = BigInt(b), C = BigInt(c);
    var num = A * B;
    var neg = (num < 0n) !== (C < 0n);
    if (num < 0n) num = -num;
    if (C < 0n) C = -C;
    var q = (2n * num + C) / (2n * C);
    return Number(neg ? -q : q);
  }

  // '1 234,5678' -> целое * 10^scale; null если строка не число
  function parseDecimal(str, decimals) {
    if (typeof str === 'number') str = String(str);
    if (typeof str !== 'string') return null;
    var s = str.replace(/[\s  ]/g, '').replace(',', '.');
    if (!/^-?\d*\.?\d*$/.test(s) || s === '' || s === '-' || s === '.' || s === '-.') return null;
    var neg = s[0] === '-';
    if (neg) s = s.slice(1);
    var parts = s.split('.');
    var intPart = parts[0] || '0';
    var frac = parts[1] || '';
    if (frac.length > decimals) {
      // округление до нужного числа знаков
      var extra = frac.slice(decimals);
      frac = frac.slice(0, decimals);
      var v = BigInt(intPart + frac.padEnd(decimals, '0'));
      if (extra[0] >= '5') v += 1n;
      return Number(neg ? -v : v);
    }
    var n = Number(BigInt(intPart + frac.padEnd(decimals, '0')));
    return neg ? -n : n;
  }

  function formatDecimal(n, decimals, keepZeros) {
    var neg = n < 0;
    var s = String(Math.abs(n)).padStart(decimals + 1, '0');
    var i = s.slice(0, s.length - decimals);
    var f = decimals ? s.slice(s.length - decimals) : '';
    if (!keepZeros) f = f.replace(/0+$/, '');
    return (neg ? '-' : '') + i + (f ? '.' + f : '');
  }

  function parseQty(str) { return parseDecimal(str, QTY_DECIMALS); }
  function qtyToNumber(q) { return q / QTY_SCALE; }
  function formatQty(q) {
    var s = formatDecimal(q, QTY_DECIMALS, false);
    var p = s.split('.');
    return p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + (p[1] ? ',' + p[1] : '');
  }

  /* ---------- валюты ---------- */

  var digitsCache = {};
  function currencyDigits(cur) {
    if (digitsCache[cur] != null) return digitsCache[cur];
    var d = 2;
    try {
      d = new Intl.NumberFormat('en', { style: 'currency', currency: cur }).resolvedOptions().maximumFractionDigits;
    } catch (e) { d = 2; }
    if (cur === 'BTC' || cur === 'ETH' || cur === 'USDT') d = 8;
    digitsCache[cur] = d;
    return d;
  }

  function parseMoney(str, cur) { return parseDecimal(str, currencyDigits(cur)); }
  function moneyToNumber(minor, cur) { return minor / Math.pow(10, currencyDigits(cur)); }
  function numberToMoney(x, cur) { return Math.round(x * Math.pow(10, currencyDigits(cur))); }

  var SYMBOLS = { KZT: '₸', RUB: '₽', USD: '$', EUR: '€', GBP: '£', CNY: '¥', JPY: '¥', TRY: '₺', AED: 'AED' };
  function formatMoney(minor, cur, opts) {
    opts = opts || {};
    var d = currencyDigits(cur);
    var x = minor / Math.pow(10, d);
    var frac = opts.compact ? 0 : (opts.digits != null ? opts.digits : d);
    var s = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: frac, maximumFractionDigits: frac }).format(Math.abs(x));
    var sign = x < 0 ? '−' : (opts.sign && x > 0 ? '+' : '');
    return sign + s + ' ' + (SYMBOLS[cur] || cur);
  }

  function formatPercent(x, opts) {
    opts = opts || {};
    if (x == null || !isFinite(x)) return '—';
    var s = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(x * 100));
    var sign = x < 0 ? '−' : (opts.sign && x > 0 ? '+' : '');
    return sign + s + ' %';
  }

  /* ---------- курсы валют ---------- */

  // rates: [{date, base, quote, rate}] — 1 base = rate quote
  function makeFx(rates) {
    var byPair = {};
    (rates || []).forEach(function (r) {
      var k = r.base + '/' + r.quote;
      (byPair[k] = byPair[k] || []).push(r);
    });
    Object.keys(byPair).forEach(function (k) {
      byPair[k].sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    });

    // последний курс на дату (или раньше); если раньше нет — самый ранний
    function lookup(base, quote, date) {
      var list = byPair[base + '/' + quote];
      if (!list || !list.length) return null;
      if (!date) return list[list.length - 1].rate;
      var found = null;
      for (var i = 0; i < list.length; i++) {
        if (list[i].date <= date) found = list[i]; else break;
      }
      return (found || list[0]).rate;
    }

    function direct(from, to, date) {
      var r = lookup(from, to, date);
      if (r != null) return r;
      r = lookup(to, from, date);
      if (r != null) return 1 / r;
      return null;
    }

    // курс from -> to: прямой, обратный или кросс через KZT/USD
    function rate(from, to, date) {
      if (from === to) return 1;
      var r = direct(from, to, date);
      if (r != null) return r;
      var hubs = ['KZT', 'USD', 'RUB', 'EUR'];
      for (var i = 0; i < hubs.length; i++) {
        var h = hubs[i];
        if (h === from || h === to) continue;
        var a = direct(from, h, date), b = direct(h, to, date);
        if (a != null && b != null) return a * b;
      }
      return null;
    }

    function convert(minor, from, to, date) {
      if (from === to) return minor;
      var r = rate(from, to, date);
      if (r == null) return null;
      var x = minor / Math.pow(10, currencyDigits(from)) * r;
      return Math.round(x * Math.pow(10, currencyDigits(to)));
    }

    return { rate: rate, convert: convert };
  }

  /* ---------- суммы операций ---------- */

  // стоимость qty бумаг по цене price в минимальных единицах
  function calcAmount(qty, price, cur, asset) {
    var x = qty / QTY_SCALE * price;
    if (asset && asset.class === 'bond' && asset.faceValue) x = x * asset.faceValue / 100;
    return Math.round(x * Math.pow(10, currencyDigits(cur)));
  }

  /* ---------- позиции ---------- */

  var TYPES = ['buy', 'sell', 'dividend', 'coupon', 'deposit', 'withdraw', 'fee', 'tax', 'split', 'transfer'];

  function sortTxs(txs) {
    return txs
      .map(function (t, i) { return { t: t, i: i }; })
      .sort(function (a, b) {
        if (a.t.date !== b.t.date) return a.t.date < b.t.date ? -1 : 1;
        var sa = a.t.seq != null ? a.t.seq : a.i, sb = b.t.seq != null ? b.t.seq : b.i;
        return sa - sb;
      })
      .map(function (x) { return x.t; });
  }

  // счета, по которым ведётся учёт денег: есть пополнения или выводы
  function fundedAccounts(txs) {
    var m = {};
    txs.forEach(function (t) { if (t.type === 'deposit' || t.type === 'withdraw') m[t.accountId] = true; });
    return m;
  }

  function posKey(accountId, assetId) { return accountId + '|' + assetId; }

  /*
   * Прогоняет операции и считает позиции и денежные остатки.
   * method: 'fifo' | 'avg'
   * Возвращает { positions: {key: Position}, cash: {accountId: {cur: minor}}, errors: [{tx, message}] }
   * Position: { accountId, assetId, currency, qty, cost, realized, income, fees, lots, firstDate }
   *   cost — себестоимость остатка с учётом комиссий покупки, в валюте актива
   *   realized — реализованная прибыль (выручка − комиссия − себестоимость проданного)
   *   income — дивиденды и купоны за вычетом налога
   */
  function computePortfolio(txs, opts) {
    opts = opts || {};
    var method = opts.method === 'avg' ? 'avg' : 'fifo';
    var positions = {};
    var cash = {};
    var funded = fundedAccounts(txs);
    var errors = [];

    function pos(accountId, assetId, cur) {
      var k = posKey(accountId, assetId);
      if (!positions[k]) {
        positions[k] = { accountId: accountId, assetId: assetId, currency: cur, qty: 0, cost: 0,
          realized: 0, income: 0, fees: 0, lots: [], firstDate: null };
      }
      return positions[k];
    }
    function addCash(accountId, cur, minor) {
      var a = cash[accountId] = cash[accountId] || {};
      a[cur] = (a[cur] || 0) + minor;
    }
    function takeLots(p, q) {
      // снимает q штук из лотов позиции, возвращает снятые лоты [{qty, cost, date}]
      var taken = [];
      if (method === 'avg') {
        var c = mulDivRound(p.cost, q, p.qty);
        taken.push({ qty: q, cost: c, date: p.lots.length ? p.lots[0].date : null });
        if (q === p.qty) p.lots = [];
        else p.lots = [{ qty: p.qty - q, cost: p.cost - c, date: p.lots[0].date }];
      } else {
        var left = q;
        while (left > 0 && p.lots.length) {
          var lot = p.lots[0];
          if (lot.qty <= left) {
            taken.push(lot);
            left -= lot.qty;
            p.lots.shift();
          } else {
            var lc = mulDivRound(lot.cost, left, lot.qty);
            taken.push({ qty: left, cost: lc, date: lot.date });
            lot.qty -= left;
            lot.cost -= lc;
            left = 0;
          }
        }
      }
      var takenCost = taken.reduce(function (s, l) { return s + l.cost; }, 0);
      p.qty -= q;
      p.cost -= takenCost;
      if (p.qty === 0) p.cost = 0;
      return taken;
    }
    function addLot(p, lot) {
      if (method === 'avg' && p.lots.length) {
        p.lots[0].qty += lot.qty;
        p.lots[0].cost += lot.cost;
      } else {
        p.lots.push({ qty: lot.qty, cost: lot.cost, date: lot.date });
      }
      p.qty += lot.qty;
      p.cost += lot.cost;
      if (!p.firstDate || lot.date < p.firstDate) p.firstDate = lot.date;
    }

    sortTxs(txs).forEach(function (t) {
      var fee = t.fee || 0, tax = t.tax || 0, amount = t.amount || 0, cur = t.currency;
      if (TYPES.indexOf(t.type) < 0) { errors.push({ tx: t, message: 'Неизвестный тип операции' }); return; }
      var p;
      switch (t.type) {
        case 'buy':
          if (!(t.quantity > 0)) { errors.push({ tx: t, message: 'Количество должно быть больше нуля' }); return; }
          p = pos(t.accountId, t.assetId, cur);
          addLot(p, { qty: t.quantity, cost: amount + fee, date: t.date });
          p.fees += fee;
          addCash(t.accountId, cur, -(amount + fee));
          break;
        case 'sell':
          p = positions[posKey(t.accountId, t.assetId)];
          if (!(t.quantity > 0)) { errors.push({ tx: t, message: 'Количество должно быть больше нуля' }); return; }
          if (!p || p.qty < t.quantity) {
            errors.push({ tx: t, message: 'Нельзя продать больше, чем есть: в наличии ' + formatQty(p ? p.qty : 0) });
            return;
          }
          var soldCost = takeLots(p, t.quantity).reduce(function (s, l) { return s + l.cost; }, 0);
          p.realized += amount - fee - soldCost;
          p.fees += fee;
          addCash(t.accountId, cur, amount - fee);
          break;
        case 'dividend':
        case 'coupon':
          p = pos(t.accountId, t.assetId, cur);
          p.income += amount - tax;
          addCash(t.accountId, cur, amount - tax);
          break;
        case 'split':
          p = positions[posKey(t.accountId, t.assetId)];
          if (!p || !t.ratio || !(t.ratio.num > 0) || !(t.ratio.den > 0)) {
            errors.push({ tx: t, message: 'Сплит: нет позиции или неверный коэффициент' });
            return;
          }
          var total = 0;
          p.lots.forEach(function (l) { l.qty = mulDivRound(l.qty, t.ratio.num, t.ratio.den); total += l.qty; });
          p.qty = total;
          break;
        case 'deposit':
          addCash(t.accountId, cur, amount);
          break;
        case 'withdraw':
          addCash(t.accountId, cur, -amount);
          break;
        case 'fee':
        case 'tax':
          if (t.assetId) {
            p = pos(t.accountId, t.assetId, cur);
            if (t.type === 'fee') p.fees += amount; else p.income -= amount;
          }
          addCash(t.accountId, cur, -amount);
          break;
        case 'transfer':
          if (!t.toAccountId) { errors.push({ tx: t, message: 'Перевод: не указан счёт получателя' }); return; }
          if (t.assetId) {
            p = positions[posKey(t.accountId, t.assetId)];
            if (!p || !(t.quantity > 0) || p.qty < t.quantity) {
              errors.push({ tx: t, message: 'Перевод: недостаточно бумаг' });
              return;
            }
            var dst = pos(t.toAccountId, t.assetId, p.currency);
            takeLots(p, t.quantity).forEach(function (l) { addLot(dst, l); });
            if (fee) addCash(t.accountId, cur, -fee);
          } else {
            addCash(t.accountId, cur, -(amount + fee));
            addCash(t.toAccountId, cur, amount);
          }
          break;
      }
    });

    return { positions: positions, cash: cash, funded: funded, errors: errors };
  }

  /* ---------- оценка ---------- */

  // prices: {assetId: {price, date}}; assets: {id: asset}
  function positionValue(p, asset, priceRec) {
    if (!priceRec || priceRec.price == null) return null;
    return calcAmount(p.qty, priceRec.price, p.currency, asset);
  }

  /*
   * Сводка портфеля в базовой валюте.
   * Возвращает { total, invested, value, cash, unrealized, realized, income, missingPrices, rows, byKey(fn) }
   */
  function summarize(state, ctx) {
    var assets = ctx.assets, prices = ctx.prices || {}, fx = ctx.fx, base = ctx.base, date = ctx.date;
    var accounts = ctx.accounts || {};
    var rows = [];
    var tot = { invested: 0, value: 0, unrealized: 0, realized: 0, income: 0, cash: 0, missingPrices: [], missingFx: [] };

    function conv(minor, cur) {
      var v = fx.convert(minor, cur, base, date);
      if (v == null) { if (tot.missingFx.indexOf(cur) < 0) tot.missingFx.push(cur); return 0; }
      return v;
    }

    Object.keys(state.positions).forEach(function (k) {
      var p = state.positions[k];
      var a = assets[p.assetId] || { id: p.assetId, ticker: '?', class: 'other', currency: p.currency };
      var acc = accounts[p.accountId];
      if (acc && acc.archived) return;
      tot.realized += conv(p.realized, p.currency);
      tot.income += conv(p.income, p.currency);
      if (p.qty === 0) return;
      var v = positionValue(p, a, prices[p.assetId]);
      var hasPrice = v != null;
      if (!hasPrice) { v = p.cost; tot.missingPrices.push(p.assetId); }
      var row = {
        key: k, accountId: p.accountId, assetId: p.assetId, asset: a, currency: p.currency, qty: p.qty,
        cost: p.cost, value: v, pnl: v - p.cost, pnlPct: p.cost ? (v - p.cost) / p.cost : null,
        avgPrice: p.qty ? p.cost / Math.pow(10, currencyDigits(p.currency)) / (p.qty / QTY_SCALE) : 0,
        valueBase: conv(v, p.currency), costBase: conv(p.cost, p.currency),
        income: p.income, realized: p.realized, hasPrice: hasPrice, price: prices[p.assetId] || null
      };
      row.pnlBase = row.valueBase - row.costBase;
      rows.push(row);
      tot.invested += row.costBase;
      tot.value += row.valueBase;
    });

    Object.keys(state.cash).forEach(function (accId) {
      var acc = accounts[accId];
      if (acc && acc.archived) return;
      if (acc && acc.trackCash === false) return;
      // деньги считаются только на счетах с записанными пополнениями или выводами;
      // иначе покупки без пополнений уводили бы остаток в минус и занижали стоимость
      if (state.funded && !state.funded[accId]) return;
      Object.keys(state.cash[accId]).forEach(function (cur) {
        tot.cash += conv(state.cash[accId][cur], cur);
      });
    });

    tot.unrealized = tot.value - tot.invested;
    tot.total = tot.value + tot.cash;
    tot.rows = rows;
    tot.byKey = function (fn) {
      var m = {};
      rows.forEach(function (r) { var key = fn(r); m[key] = (m[key] || 0) + r.valueBase; });
      return m;
    };
    return tot;
  }

  /* ---------- XIRR ---------- */

  var DAY = 86400000;
  function toTime(d) { return Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)); }
  function daysBetween(a, b) { return Math.round((toTime(b) - toTime(a)) / DAY); }

  // flows: [{date, amount}] (минус — вложение, плюс — возврат). Возвращает годовую ставку или null.
  function xirr(flows) {
    flows = flows.filter(function (f) { return f.amount !== 0; });
    if (flows.length < 2) return null;
    var hasNeg = flows.some(function (f) { return f.amount < 0; });
    var hasPos = flows.some(function (f) { return f.amount > 0; });
    if (!hasNeg || !hasPos) return null;
    var d0 = flows.reduce(function (m, f) { return f.date < m ? f.date : m; }, flows[0].date);
    var ts = flows.map(function (f) { return { y: daysBetween(d0, f.date) / 365, a: f.amount }; });
    if (ts.every(function (t) { return t.y === 0; })) return null;

    function npv(r) { return ts.reduce(function (s, t) { return s + t.a / Math.pow(1 + r, t.y); }, 0); }
    function dnpv(r) { return ts.reduce(function (s, t) { return s - t.y * t.a / Math.pow(1 + r, t.y + 1); }, 0); }

    // Ньютон
    var r = 0.1;
    for (var i = 0; i < 100; i++) {
      var f = npv(r), df = dnpv(r);
      if (!isFinite(f) || !isFinite(df) || df === 0) break;
      var nr = r - f / df;
      if (nr <= -0.999999) nr = (r - 0.999999) / 2;
      if (Math.abs(nr - r) < 1e-10) { if (Math.abs(npv(nr)) < 1e-6 * scale()) return nr; break; }
      r = nr;
    }
    // бисекция
    function scale() { return ts.reduce(function (s, t) { return s + Math.abs(t.a); }, 0) || 1; }
    var lo = -0.999999, hi = 1;
    var flo = npv(lo), fhi = npv(hi);
    while (flo * fhi > 0 && hi < 1e6) { hi *= 2; fhi = npv(hi); }
    if (flo * fhi > 0) return null;
    for (var j = 0; j < 300; j++) {
      var mid = (lo + hi) / 2, fm = npv(mid);
      if (Math.abs(fm) < 1e-9 * scale() || (hi - lo) < 1e-12) return mid;
      if (flo * fm < 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
    }
    return (lo + hi) / 2;
  }

  /*
   * Денежные потоки инвестора в базовой валюте для XIRR.
   * Для счетов с пополнениями/выводами учитываются только они (плюс остаток денег на конец),
   * для остальных — покупки, продажи и выплаты (плюс стоимость бумаг на конец).
   */
  function investorFlows(txs, summary, ctx) {
    var fx = ctx.fx, base = ctx.base, date = ctx.date;
    var depositMode = fundedAccounts(txs);
    var flows = [];
    function conv(minor, cur, d) { var v = fx.convert(minor, cur, base, d); return v == null ? 0 : v; }
    txs.forEach(function (t) {
      var acc = ctx.accounts && ctx.accounts[t.accountId];
      if (acc && acc.archived) return;
      var dm = depositMode[t.accountId], a = t.amount || 0, fee = t.fee || 0, tax = t.tax || 0, x = null;
      if (dm) {
        if (t.type === 'deposit') x = -a;
        else if (t.type === 'withdraw') x = a;
        else if (t.type === 'transfer' && !t.assetId && t.toAccountId && !depositMode[t.toAccountId]) x = a;
      } else {
        if (t.type === 'buy') x = -(a + fee);
        else if (t.type === 'sell') x = a - fee;
        else if (t.type === 'dividend' || t.type === 'coupon') x = a - tax;
        else if (t.type === 'fee' || t.type === 'tax') x = -a;
      }
      if (x) flows.push({ date: t.date, amount: conv(x, t.currency, t.date) });
    });
    var terminal = 0;
    summary.rows.forEach(function (r) { terminal += r.valueBase; });
    // деньги на счетах, где учитываются пополнения
    Object.keys(ctx.cash || {}).forEach(function (accId) {
      if (!depositMode[accId]) return;
      var acc = ctx.accounts && ctx.accounts[accId];
      if (acc && acc.archived) return;
      Object.keys(ctx.cash[accId]).forEach(function (cur) { terminal += conv(ctx.cash[accId][cur], cur, date); });
    });
    if (terminal) flows.push({ date: date, amount: terminal });
    return flows;
  }

  /* ---------- ребалансировка ---------- */

  /*
   * current: {key: value}, targets: {key: percent (0..100)}, cash: сумма пополнения.
   * Только покупки: деньги распределяются по недовешенным долям.
   * Возвращает { buys: {key: amount}, deviation: {key: {current, target, diff}} }
   */
  function rebalance(current, targets, cash) {
    cash = cash || 0;
    var keys = Object.keys(targets).concat(Object.keys(current).filter(function (k) { return !(k in targets); }));
    var total = keys.reduce(function (s, k) { return s + (current[k] || 0); }, 0);
    var newTotal = total + cash;
    var deviation = {};
    var deficits = {};
    var sumDef = 0;
    keys.forEach(function (k) {
      var cur = current[k] || 0, tgt = (targets[k] || 0) / 100;
      deviation[k] = { current: total ? cur / total : 0, target: tgt, diff: (total ? cur / total : 0) - tgt };
      var d = Math.max(0, Math.round(tgt * newTotal) - cur);
      if (d > 0) { deficits[k] = d; sumDef += d; }
    });
    var buys = {};
    if (cash <= 0 || sumDef === 0) return { buys: buys, deviation: deviation };
    var budget = Math.min(cash, sumDef);
    var given = 0;
    var dk = Object.keys(deficits);
    dk.forEach(function (k) { buys[k] = sumDef <= cash ? deficits[k] : Math.floor(deficits[k] * budget / sumDef); given += buys[k]; });
    // остаток от округления — самой недовешенной доле
    if (given < budget && dk.length) {
      dk.sort(function (a, b) { return deficits[b] - deficits[a]; });
      buys[dk[0]] += budget - given;
    }
    return { buys: buys, deviation: deviation };
  }

  /* ---------- импорт и экспорт ---------- */

  // CSV → массив строк; разделитель (; , или таб) определяется по первой строке
  function parseCSV(text) {
    text = String(text || '').replace(/^﻿/, '');
    var first = text.split(/\r?\n/)[0] || '';
    var counts = { ';': 0, ',': 0, '\t': 0 }, inQ = false;
    for (var i = 0; i < first.length; i++) {
      var ch = first[i];
      if (ch === '"') inQ = !inQ;
      else if (!inQ && ch in counts) counts[ch]++;
    }
    var delim = ';';
    if (counts['\t'] > counts[delim]) delim = '\t';
    if (counts[','] > counts[delim]) delim = ',';
    var rows = [], row = [], cell = '', q = false;
    for (var j = 0; j < text.length; j++) {
      var c = text[j];
      if (q) {
        if (c === '"') { if (text[j + 1] === '"') { cell += '"'; j++; } else q = false; }
        else cell += c;
      } else if (c === '"') q = true;
      else if (c === delim) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[j + 1] === '\n') j++;
        row.push(cell); cell = '';
        if (row.some(function (x) { return x.trim() !== ''; })) rows.push(row);
        row = [];
      } else cell += c;
    }
    row.push(cell);
    if (row.some(function (x) { return x.trim() !== ''; })) rows.push(row);
    return { rows: rows, delimiter: delim };
  }

  function csvCell(v) {
    v = v == null ? '' : String(v);
    return /[";\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }

  // 'YYYY-MM-DD', 'DD.MM.YYYY', 'DD/MM/YYYY', 'DD.MM.YY', ISO с временем → 'YYYY-MM-DD' или null
  function parseDateAny(s) {
    s = String(s || '').trim();
    var m, y, mo, d;
    if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else if ((m = /^(\d{1,2})[./](\d{1,2})[./](\d{2,4})/.exec(s))) { d = +m[1]; mo = +m[2]; y = +m[3]; if (y < 100) y += 2000; }
    else return null;
    var t = new Date(Date.UTC(y, mo - 1, d));
    if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
    return t.toISOString().slice(0, 10);
  }

  var TYPE_ALIASES = {
    buy: ['buy', 'b', 'покупка', 'купля', 'куплено', 'купил'],
    sell: ['sell', 's', 'продажа', 'продано', 'продал'],
    dividend: ['dividend', 'dividends', 'div', 'дивиденд', 'дивиденды'],
    coupon: ['coupon', 'купон', 'купоны', 'купонный доход'],
    deposit: ['deposit', 'пополнение', 'ввод', 'зачисление', 'ввод денег'],
    withdraw: ['withdraw', 'withdrawal', 'вывод', 'снятие', 'вывод денег'],
    fee: ['fee', 'commission', 'комиссия'],
    tax: ['tax', 'налог'],
    split: ['split', 'сплит'],
    transfer: ['transfer', 'перевод']
  };
  function detectType(s) {
    s = String(s || '').trim().toLowerCase().replace(/ё/g, 'е');
    if (!s) return null;
    var keys = Object.keys(TYPE_ALIASES), k, i;
    for (k = 0; k < keys.length; k++) if (TYPE_ALIASES[keys[k]].some(function (a) { return a.replace(/ё/g, 'е') === s; })) return keys[k];
    for (k = 0; k < keys.length; k++) {
      var al = TYPE_ALIASES[keys[k]];
      for (i = 0; i < al.length; i++) if (al[i].length > 2 && s.indexOf(al[i].replace(/ё/g, 'е')) === 0) return keys[k];
    }
    return null;
  }

  var CSV_FIELDS = {
    date: ['date', 'дата', 'дата сделки', 'дата операции', 'trade date'],
    type: ['type', 'тип', 'операция', 'вид операции', 'тип операции', 'side'],
    ticker: ['ticker', 'тикер', 'symbol', 'инструмент', 'бумага', 'код'],
    name: ['name', 'название', 'наименование'],
    quantity: ['quantity', 'qty', 'количество', 'кол-во', 'кол во', 'шт'],
    price: ['price', 'цена'],
    amount: ['amount', 'сумма', 'объем', 'объём', 'total'],
    fee: ['fee', 'комиссия', 'commission'],
    tax: ['tax', 'налог'],
    currency: ['currency', 'валюта', 'cur'],
    account: ['account', 'счет', 'счёт'],
    toAccount: ['to account', 'куда', 'счет получателя', 'счёт получателя'],
    ratio: ['ratio', 'коэффициент'],
    note: ['note', 'comment', 'комментарий', 'заметка', 'примечание']
  };
  function guessMapping(headers) {
    var norm = headers.map(function (h) { return String(h || '').trim().toLowerCase().replace(/ё/g, 'е'); });
    var map = {};
    Object.keys(CSV_FIELDS).forEach(function (f) {
      var al = CSV_FIELDS[f].map(function (a) { return a.replace(/ё/g, 'е'); });
      var idx = norm.findIndex(function (h) { return al.indexOf(h) >= 0; });
      if (idx < 0) idx = norm.findIndex(function (h) { return al.some(function (a) { return a.length > 3 && h.indexOf(a) === 0; }); });
      if (idx >= 0 && Object.keys(map).every(function (k) { return map[k] !== idx; })) map[f] = idx;
    });
    return map;
  }

  /*
   * Строки CSV (без заголовка) → операции.
   * opts: { accounts, assets, defaultAccountId, defaultCurrency, seqStart, uid }
   * Возвращает { txs, newAssets, errors: [{row, message}] }
   */
  function csvToTxs(rows, map, opts) {
    var accounts = opts.accounts || [], assets = (opts.assets || []).slice(), newAssets = [];
    var txs = [], errors = [], seq = opts.seqStart || 0, mk = opts.uid || uid;
    function get(r, f) { return map[f] != null && map[f] >= 0 ? String(r[map[f]] == null ? '' : r[map[f]]).trim() : ''; }
    function findAccount(name) {
      if (!name) return null;
      var n = name.toLowerCase();
      var a = accounts.find(function (x) { return x.name.toLowerCase() === n || x.id === name; });
      return a ? a.id : null;
    }
    function absNum(s, dec) { var v = parseDecimal(String(s).replace(/^[−–]/, '-'), dec); return v == null ? null : Math.abs(v); }
    rows.forEach(function (r, i) {
      var line = i + 1;
      var fail = function (m) { errors.push({ row: line, message: m }); };
      var date = parseDateAny(get(r, 'date'));
      if (!date) return fail('Не распознана дата «' + get(r, 'date') + '»');
      var type = detectType(get(r, 'type'));
      if (!type) return fail('Не распознан тип операции «' + get(r, 'type') + '»');
      var accountId = findAccount(get(r, 'account')) || opts.defaultAccountId;
      if (!accountId) return fail('Не найден счёт');
      var ticker = get(r, 'ticker').toUpperCase();
      var asset = null;
      if (ticker) {
        asset = assets.find(function (a) { return a.ticker.toUpperCase() === ticker; });
        if (!asset) {
          var cur0 = get(r, 'currency').toUpperCase() || opts.defaultCurrency || 'KZT';
          asset = { id: mk(), ticker: ticker, name: get(r, 'name') || ticker, class: 'stock', currency: cur0, exchange: 'KASE' };
          assets.push(asset); newAssets.push(asset);
        }
      }
      var needAsset = ['buy', 'sell', 'dividend', 'coupon', 'split'].indexOf(type) >= 0;
      if (needAsset && !asset) return fail('Не указан тикер');
      var cur = (asset && asset.currency) || get(r, 'currency').toUpperCase() || opts.defaultCurrency || 'KZT';
      var t = { id: mk(), seq: ++seq, type: type, date: date, accountId: accountId, currency: cur };
      if (asset && (needAsset || type === 'fee' || type === 'tax' || type === 'transfer')) t.assetId = asset.id;
      var note = get(r, 'note'); if (note) t.note = note;
      var qty = absNum(get(r, 'quantity'), QTY_DECIMALS);
      var priceStr = get(r, 'price').replace(/[\s ]/g, '').replace(',', '.');
      var price = priceStr ? Math.abs(Number(priceStr)) : null;
      var amount = absNum(get(r, 'amount'), currencyDigits(cur));
      if (type === 'buy' || type === 'sell' || (type === 'transfer' && asset)) {
        if (!(qty > 0)) return fail('Не указано количество');
        t.quantity = qty;
      }
      if (type === 'buy' || type === 'sell') {
        if (price > 0) t.price = price;
        if (!(amount > 0)) {
          if (!(price > 0)) return fail('Нужна цена или сумма');
          amount = calcAmount(qty, price, cur, asset);
        }
      }
      if (type === 'split') {
        var m = /^(\d+)\s*[:/]\s*(\d+)$/.exec(get(r, 'ratio'));
        if (!m) return fail('Не указан коэффициент сплита, например 2:1');
        t.ratio = { num: +m[1], den: +m[2] };
      } else if (!(type === 'transfer' && asset)) {
        if (!(amount > 0)) return fail('Не указана сумма');
        t.amount = amount;
      }
      var fee = absNum(get(r, 'fee'), currencyDigits(cur)); if (fee) t.fee = fee;
      var tax = absNum(get(r, 'tax'), currencyDigits(cur)); if (tax) t.tax = tax;
      if (type === 'transfer') {
        t.toAccountId = findAccount(get(r, 'toAccount'));
        if (!t.toAccountId) return fail('Не найден счёт получателя');
      }
      txs.push(t);
    });
    return { txs: txs, newAssets: newAssets, errors: errors };
  }

  var TYPE_RU = { buy: 'Покупка', sell: 'Продажа', dividend: 'Дивиденд', coupon: 'Купон', deposit: 'Пополнение', withdraw: 'Вывод',
    fee: 'Комиссия', tax: 'Налог', split: 'Сплит', transfer: 'Перевод' };

  // операции → CSV (разделитель «;», десятичная запятая — открывается в Excel с русской локалью)
  function txsToCSV(data) {
    var acc = {}, as = {};
    (data.accounts || []).forEach(function (a) { acc[a.id] = a; });
    (data.assets || []).forEach(function (a) { as[a.id] = a; });
    var dec = function (s) { return String(s).replace('.', ','); };
    var head = ['Дата', 'Тип', 'Счёт', 'Тикер', 'Название', 'Количество', 'Цена', 'Сумма', 'Комиссия', 'Налог', 'Валюта', 'Счёт получателя', 'Коэффициент', 'Заметка'];
    var lines = [head.join(';')];
    sortTxs(data.txs || []).forEach(function (t) {
      var a = as[t.assetId], d = currencyDigits(t.currency);
      lines.push([
        t.date, TYPE_RU[t.type] || t.type, acc[t.accountId] ? acc[t.accountId].name : t.accountId,
        a ? a.ticker : '', a ? a.name : '',
        t.quantity ? dec(formatDecimal(t.quantity, QTY_DECIMALS, false)) : '',
        t.price != null ? dec(t.price) : '',
        t.amount ? dec(formatDecimal(t.amount, d, true)) : '',
        t.fee ? dec(formatDecimal(t.fee, d, true)) : '',
        t.tax ? dec(formatDecimal(t.tax, d, true)) : '',
        t.currency, t.toAccountId && acc[t.toAccountId] ? acc[t.toAccountId].name : '',
        t.ratio ? t.ratio.num + ':' + t.ratio.den : '', t.note || ''
      ].map(csvCell).join(';'));
    });
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  var BACKUP_KEYS = ['accounts', 'assets', 'txs', 'prices', 'fx', 'targets', 'settings', 'seq'];

  function makeBackup(data, now) {
    var out = {};
    BACKUP_KEYS.forEach(function (k) { out[k] = data[k]; });
    return { app: 'portfolio', version: 1, exportedAt: now || new Date().toISOString(), data: out };
  }

  // проверка резервной копии: { ok, error?, data?, counts? }
  function validateBackup(obj) {
    if (!obj || typeof obj !== 'object') return { ok: false, error: 'Файл не похож на резервную копию' };
    if (obj.app !== 'portfolio' || !obj.data) return { ok: false, error: 'Это не резервная копия приложения «Портфель»' };
    if (!(obj.version <= 1)) return { ok: false, error: 'Копия создана более новой версией приложения — обновите приложение' };
    var d = obj.data;
    var arr = ['accounts', 'assets', 'txs', 'fx'];
    for (var i = 0; i < arr.length; i++) if (d[arr[i]] != null && !Array.isArray(d[arr[i]])) return { ok: false, error: 'Повреждён раздел ' + arr[i] };
    var txs = d.txs || [];
    for (var j = 0; j < txs.length; j++) {
      var t = txs[j];
      if (!t || !t.id || TYPES.indexOf(t.type) < 0 || !parseDateAny(t.date) || !t.accountId || !t.currency)
        return { ok: false, error: 'Повреждена операция №' + (j + 1) };
      var ints = ['quantity', 'amount', 'fee', 'tax'];
      for (var k = 0; k < ints.length; k++) if (t[ints[k]] != null && !Number.isInteger(t[ints[k]]))
        return { ok: false, error: 'Операция №' + (j + 1) + ': неверное поле ' + ints[k] };
    }
    var ok = function (list) { return (list || []).every(function (x) { return x && x.id; }); };
    if (!ok(d.accounts) || !ok(d.assets)) return { ok: false, error: 'Повреждены счета или активы' };
    return { ok: true, data: d, counts: { accounts: (d.accounts || []).length, assets: (d.assets || []).length, txs: txs.length } };
  }

  /*
   * Объединение данных: новые записи добавляются, существующие (тот же id) не трогаются.
   * Активы с тем же тикером считаются одним активом — ссылки на них переназначаются.
   */
  function mergeData(cur, inc) {
    var out = {
      accounts: (cur.accounts || []).slice(), assets: (cur.assets || []).slice(), txs: (cur.txs || []).slice(),
      prices: Object.assign({}, cur.prices || {}), fx: (cur.fx || []).slice(),
      targets: cur.targets, settings: cur.settings, seq: cur.seq || 0
    };
    var added = { accounts: 0, assets: 0, txs: 0 }, skipped = 0;
    var accIds = {}, assetIds = {}, tickers = {}, txIds = {};
    out.accounts.forEach(function (a) { accIds[a.id] = true; });
    out.assets.forEach(function (a) { assetIds[a.id] = a.id; tickers[a.ticker.toUpperCase()] = a.id; });
    out.txs.forEach(function (t) { txIds[t.id] = true; });
    var remap = {};
    (inc.accounts || []).forEach(function (a) { if (!accIds[a.id]) { out.accounts.push(a); accIds[a.id] = true; added.accounts++; } });
    (inc.assets || []).forEach(function (a) {
      var same = tickers[a.ticker.toUpperCase()];
      if (assetIds[a.id]) return;
      if (same) { remap[a.id] = same; return; }
      out.assets.push(a); assetIds[a.id] = a.id; tickers[a.ticker.toUpperCase()] = a.id; added.assets++;
    });
    var seqBase = out.seq;
    (inc.txs || []).forEach(function (t) {
      if (txIds[t.id]) { skipped++; return; }
      var c = Object.assign({}, t);
      if (c.assetId && remap[c.assetId]) c.assetId = remap[c.assetId];
      c.seq = seqBase + (t.seq || 0);
      out.txs.push(c); txIds[c.id] = true; added.txs++;
      if (c.seq > out.seq) out.seq = c.seq;
    });
    Object.keys(inc.prices || {}).forEach(function (id) {
      var target = remap[id] || id;
      var list = (out.prices[target] || []).slice();
      var dates = {}; list.forEach(function (p) { dates[p.date] = true; });
      inc.prices[id].forEach(function (p) { if (!dates[p.date]) list.push(p); });
      list.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
      out.prices[target] = list;
    });
    var fxKeys = {};
    out.fx.forEach(function (r) { fxKeys[r.date + r.base + r.quote] = true; });
    (inc.fx || []).forEach(function (r) { if (!fxKeys[r.date + r.base + r.quote]) { out.fx.push(r); fxKeys[r.date + r.base + r.quote] = true; } });
    return { data: out, added: added, skipped: skipped };
  }

  /* ---------- PIN-код ---------- */
  // PIN защищает от случайного просмотра; хранится только хэш SHA-256 от «соль:PIN»

  function toHex(bytes) { return Array.prototype.map.call(bytes, function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join(''); }
  function pinSupported() { return !!(root.crypto && root.crypto.subtle && root.crypto.getRandomValues); }
  function randomSalt() { var a = new Uint8Array(16); root.crypto.getRandomValues(a); return toHex(a); }
  function validPin(pin) { return /^\d{4,6}$/.test(String(pin)); }
  function hashPin(pin, salt) {
    return root.crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + ':' + pin)).then(function (buf) { return toHex(new Uint8Array(buf)); });
  }
  function makePin(pin) {
    var salt = randomSalt();
    return hashPin(pin, salt).then(function (hash) { return { salt: salt, hash: hash, len: String(pin).length, lockAfter: 0 }; });
  }
  function checkPin(pin, rec) { return rec && rec.hash ? hashPin(pin, rec.salt).then(function (h) { return h === rec.hash; }) : Promise.resolve(false); }

  /* ---------- утилиты ---------- */

  function uid() {
    if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  var api = {
    QTY_SCALE: QTY_SCALE,
    TYPES: TYPES,
    mulDivRound: mulDivRound,
    parseDecimal: parseDecimal,
    parseQty: parseQty,
    qtyToNumber: qtyToNumber,
    formatQty: formatQty,
    currencyDigits: currencyDigits,
    parseMoney: parseMoney,
    moneyToNumber: moneyToNumber,
    numberToMoney: numberToMoney,
    formatMoney: formatMoney,
    formatPercent: formatPercent,
    makeFx: makeFx,
    calcAmount: calcAmount,
    computePortfolio: computePortfolio,
    summarize: summarize,
    xirr: xirr,
    investorFlows: investorFlows,
    rebalance: rebalance,
    daysBetween: daysBetween,
    uid: uid,
    today: today,
    parseCSV: parseCSV,
    parseDateAny: parseDateAny,
    detectType: detectType,
    CSV_FIELDS: CSV_FIELDS,
    guessMapping: guessMapping,
    csvToTxs: csvToTxs,
    txsToCSV: txsToCSV,
    makeBackup: makeBackup,
    validateBackup: validateBackup,
    mergeData: mergeData,
    pinSupported: pinSupported,
    validPin: validPin,
    hashPin: hashPin,
    makePin: makePin,
    checkPin: checkPin
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PortfolioCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
