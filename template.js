/*
 * Портфель — импорт из Excel-шаблона учёта брокерского счёта
 * (листы «Параметры», «Котировки», «Сделки», «Деньги», «Дивиденды»).
 * Шаблон — полная история одного счёта, поэтому импорт заменяет все операции выбранного счёта.
 * Чистые функции: на вход — книга из PortfolioXlsx.readXlsx, на выход — данные приложения.
 */
(function (root) {
  'use strict';
  const C = typeof require !== 'undefined' ? require('./core.js') : root.PortfolioCore;
  const X = typeof require !== 'undefined' ? require('./xlsx.js') : root.PortfolioXlsx;

  const REQUIRED = ['Параметры', 'Котировки', 'Сделки', 'Деньги'];

  // известные бумаги: ISIN → [тикер, биржа]; для остальных цена обновляется вручную
  const KNOWN = {
    KZ1C00001536: ['KSPI', 'KASE'], KZ1C00000959: ['KEGC', 'KASE'], KZ0009094645: ['KZTKp', 'KASE'],
    KZ0009093241: ['KZTK', 'KASE'], KZ1C00001619: ['KZAP', 'KASE'], KZ1C00004050: ['AIRA', 'KASE'],
    KZ000A0LE0S4: ['HSBK', 'KASE'], KZ1C00000876: ['KCEL', 'KASE'], KZ1C00000744: ['KZTO', 'KASE'],
    KZ1C00001122: ['KMGZ', 'KASE'], KZ1C00001213: ['KASE', 'KASE'],
    US67066G1040: ['NVDA', 'NASDAQ'], US4581401001: ['INTC', 'NASDAQ'], US0231351067: ['AMZN', 'NASDAQ'],
    US8552441094: ['SBUX', 'NASDAQ'], US0378331005: ['AAPL', 'NASDAQ'], US5949181045: ['MSFT', 'NASDAQ'],
    US37954Y8710: ['URA', 'NYSE'], US3453708600: ['F', 'NYSE'], US7170811035: ['PFE', 'NYSE'],
    US00206R1023: ['T', 'NYSE'], US74347G4405: ['BITO', 'NYSE'], US1912161007: ['KO', 'NYSE'],
    US78409V1044: ['SPGI', 'NYSE'], US78462F1030: ['SPY', 'NYSE']
  };

  // слова в названиях эмитентов, которые не помогают найти бумагу
  const STOP = new Set(['ао', 'тоо', 'нк', 'ак', 'inc', 'corp', 'corporation', 'company', 'co', 'the', 'ltd', 'plc', 'llc',
    'национальная', 'национальный', 'компания', 'частная', 'акционерное', 'общество', 'казахстан', 'казахстана',
    'kz', 'jsc', 'ао«', 'по', 'и', 'of', 'преф', 'простые', 'облигация']);
  // эмитент → фрагмент названия бумаги в «Котировках», если названия не похожи
  const ISSUER_HINTS = [
    ['электрическими сетями', 'kegoc'], ['народный банк', 'halyk'], ['kaspi', 'kaspi'], ['темiр жолы', 'темир жолы'],
    ['темир жолы', 'темир жолы'], ['proshares', 'bitcoin etf'], ['at & t', 'at&t'], ['coca-cola', 'coca-cola'],
    ['кселл', 'кселл'], ['kcell', 'кселл']
  ];

  function norm(s) { return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[«»"'“”.,()]/g, ' ').replace(/\s+/g, ' ').trim(); }
  function tokens(s) { return norm(s).split(' ').filter(t => t.length > 1 && !STOP.has(t)); }

  function toDate(v, date1904) {
    if (typeof v === 'number') return X.excelDate(v, date1904);
    return C.parseDateAny(v);
  }
  function toNum(v) {
    if (typeof v === 'number') return v;
    if (v == null || v === '') return null;
    const n = Number(String(v).replace(/[\s ]/g, '').replace(',', '.'));
    return isFinite(n) ? n : null;
  }
  function money(v, cur) { return C.parseDecimal(String(+Number(v).toFixed(8)), C.currencyDigits(cur)); }
  function qty(v) { return C.parseQty(String(+Number(v).toFixed(8))); }

  function rows(sheet, cols) {
    const out = [];
    for (let r = 5; r <= sheet.maxRow; r++) {
      const a = sheet.cells['A' + r];
      if (a == null || a === '') continue;
      const o = { row: r };
      cols.forEach((c, i) => { o[c] = sheet.cells[String.fromCharCode(65 + i) + r]; });
      out.push(o);
    }
    return out;
  }

  /*
   * Преобразует книгу в данные приложения.
   * opts: { accountId, uid, seqStart }
   * Возвращает { ok, error, report, assets, txs, prices, fx, warnings: [строки], skipped: [{sheet,row,message}] }
   */
  function templateToData(book, opts) {
    opts = opts || {};
    const missing = REQUIRED.filter(n => !book.sheets[n]);
    if (missing.length) return { ok: false, error: 'Это не шаблон учёта: нет листов ' + missing.map(n => '«' + n + '»').join(', ') };
    const uid = opts.uid || C.uid, acc = opts.accountId || 'acc-template';
    const d1904 = book.date1904;
    const skipped = [], warnings = [];
    const skip = (sheet, row, message) => skipped.push({ sheet, row, message });

    // Параметры
    const P = book.sheets['Параметры'].cells;
    const reportDate = toDate(P.B4, d1904);
    if (!reportDate) return { ok: false, error: 'На листе «Параметры» не указана дата отчёта (B4)' };
    const cashActual = { KZT: toNum(P.B5), USD: toNum(P.B6) };
    const reportRate = toNum(P.B7);
    const yearly = {};
    for (let r = 11; r <= 30; r++) { const y = toNum(P['A' + r]), v = toNum(P['B' + r]); if (y && v) yearly[y] = v; }

    // Котировки — справочник бумаг
    const assets = [], byId = {}, prices = {};
    rows(book.sheets['Котировки'], ['isin', 'name', 'cur', 'type', 'market', 'sector', 'price', 'psrc']).forEach(r => {
      const isin = String(r.isin).trim().toUpperCase();
      const cur = String(r.cur || '').trim().toUpperCase();
      if (!cur) return skip('Котировки', r.row, 'не указана валюта');
      if (byId[isin]) return skip('Котировки', r.row, 'бумага ' + isin + ' указана повторно');
      const type = norm(r.type);
      const cls = type.startsWith('акци') ? 'stock' : type.startsWith('облига') ? 'bond'
        : type.includes('фонд') || type.includes('etf') ? (isin.startsWith('KZPF') ? 'fund' : 'etf') : 'other';
      const known = KNOWN[isin];
      const a = { id: isin, ticker: known ? known[0] : isin, name: String(r.name || isin).trim(), class: cls, currency: cur,
        exchange: known ? known[1] : 'OTC', isin };
      if (r.sector) a.sector = String(r.sector).trim();
      if (r.market) a.market = String(r.market).trim();
      if (!known) a.quoteSource = 'manual';
      assets.push(a); byId[isin] = a;
      const pr = toNum(r.price);
      if (pr > 0) prices[isin] = [{ date: reportDate, price: pr, source: 'manual' }];
    });

    const txs = [];
    const add = (t, order) => { t.id = uid(); t.accountId = acc; t._o = order; txs.push(t); };

    // Деньги: пополнения и выводы; курс — как в шаблоне: вручную, иначе средний за год, иначе курс оценки
    const fxRates = [];
    rows(book.sheets['Деньги'], ['date', 'kind', 'cur', 'sum', 'note', 'rate']).forEach(r => {
      const date = toDate(r.date, d1904), cur = String(r.cur || '').trim().toUpperCase(), sum = toNum(r.sum), kind = norm(r.kind);
      if (!date) return skip('Деньги', r.row, 'не распознана дата');
      if (!(sum > 0)) return skip('Деньги', r.row, 'не указана сумма');
      if (!cur) return skip('Деньги', r.row, 'не указана валюта');
      const type = kind.startsWith('попол') ? 'deposit' : kind.startsWith('вывод') ? 'withdraw' : null;
      if (!type) return skip('Деньги', r.row, 'тип должен быть «Пополнение» или «Вывод»');
      const t = { type, date, currency: cur, amount: money(sum, cur) };
      if (r.note) t.note = String(r.note);
      add(t, 0);
      if (cur === 'USD') {
        const rate = toNum(r.rate) || yearly[+date.slice(0, 4)] || reportRate;
        if (rate) fxRates.push({ date, base: 'USD', quote: 'KZT', rate, source: 'nbk' });
      }
    });

    // Сделки
    let n = 0;
    rows(book.sheets['Сделки'], ['date', 'isin', 'name', 'cur', 'op', 'qty', 'sum']).forEach(r => {
      const date = toDate(r.date, d1904), isin = String(r.isin || '').trim().toUpperCase(), a = byId[isin];
      const q = toNum(r.qty), sum = toNum(r.sum), op = norm(r.op);
      if (!date) return skip('Сделки', r.row, 'не распознана дата');
      if (!a) return skip('Сделки', r.row, 'бумаги ' + isin + ' нет на листе «Котировки»');
      if (!(q > 0)) return skip('Сделки', r.row, 'не указано количество');
      if (sum == null || sum < 0) return skip('Сделки', r.row, 'не указана сумма сделки');
      const type = op.startsWith('покуп') ? 'buy' : op.startsWith('продаж') || op.startsWith('погаш') ? 'sell' : null;
      if (!type) return skip('Сделки', r.row, 'операция должна быть «Покупка» или «Продажа»');
      const t = { type, date, assetId: isin, currency: a.currency, quantity: qty(q), amount: money(sum, a.currency), fee: 0 };
      if (sum > 0) t.price = +(sum / q).toFixed(6);
      add(t, 1 + (n++) / 100000);
      if (t.price) {
        const list = prices[isin] = prices[isin] || [];
        if (!list.some(p => p.date === date)) list.push({ date, price: t.price, source: 'trade' });
      }
    });

    // остаток бумаги на дату — для выбора, к какой бумаге эмитента отнести выплату
    const held = (isin, date) => txs.reduce((s, t) => t.assetId === isin && t.date <= date && (t.type === 'buy' || t.type === 'sell')
      ? s + (t.type === 'buy' ? t.quantity : -t.quantity) : s, 0);

    function findAsset(issuer, cur, date) {
      const ni = norm(issuer);
      let cands = [];
      ISSUER_HINTS.forEach(([k, frag]) => { if (ni.includes(k)) cands = cands.concat(assets.filter(a => norm(a.name).includes(frag))); });
      if (!cands.length) {
        const it = tokens(issuer);
        let best = 0;
        assets.forEach(a => {
          const at = tokens(a.name);
          const score = it.filter(t => at.some(x => x === t || (t.length > 3 && (x.startsWith(t) || t.startsWith(x))))).length;
          if (score > best) { best = score; cands = [a]; } else if (score && score === best) cands.push(a);
        });
      }
      cands = cands.filter((a, i) => cands.indexOf(a) === i);
      const sameCur = cands.filter(a => a.currency === cur);
      if (sameCur.length) cands = sameCur;
      const heldNow = cands.filter(a => held(a.id, date) > 0);
      return (heldNow.length ? heldNow : cands)[0] || null;
    }

    // Дивиденды и купоны
    if (book.sheets['Дивиденды']) {
      rows(book.sheets['Дивиденды'], ['date', 'issuer', 'kind', 'cur', 'sum']).forEach(r => {
        const date = toDate(r.date, d1904), cur = String(r.cur || '').trim().toUpperCase(), sum = toNum(r.sum);
        if (!date) return skip('Дивиденды', r.row, 'не распознана дата');
        if (!(sum > 0)) return skip('Дивиденды', r.row, 'не указана сумма');
        const a = findAsset(r.issuer, cur, date);
        if (!a) return skip('Дивиденды', r.row, 'не найдена бумага эмитента «' + r.issuer + '»');
        add({ type: norm(r.kind).startsWith('купон') ? 'coupon' : 'dividend', date, assetId: a.id, currency: cur || a.currency,
          amount: money(sum, cur || a.currency) }, 2);
      });
    }

    // сверка с выпиской: в шаблоне нет комиссий и удержаний, а остаток денег — фактический
    const calc = {};
    txs.forEach(t => {
      const sign = { deposit: 1, withdraw: -1, buy: -1, sell: 1, dividend: 1, coupon: 1 }[t.type];
      calc[t.currency] = (calc[t.currency] || 0) + sign * t.amount;
    });
    const recon = [];
    Object.keys(cashActual).forEach(cur => {
      if (cashActual[cur] == null) return;
      const gap = money(cashActual[cur], cur) - (calc[cur] || 0);
      if (gap < 0) {
        add({ type: 'fee', date: reportDate, currency: cur, amount: -gap,
          note: 'Сверка с выпиской брокера: комиссии и прочие списания, которых нет в шаблоне' }, 3);
        recon.push({ currency: cur, amount: -gap });
      } else if (gap > 0) {
        warnings.push(`Остаток ${cur} у брокера больше расчётного на ${C.formatMoney(gap, cur)} — проверьте, все ли пополнения и выплаты внесены в шаблон`);
      }
    });

    txs.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a._o - b._o);
    let seq = opts.seqStart || 0;
    txs.forEach(t => { t.seq = ++seq; delete t._o; });
    Object.keys(prices).forEach(id => prices[id].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    // курсы: среднегодовые, курс каждого долларового пополнения, курс оценки на дату отчёта
    const fx = Object.keys(yearly).map(y => ({ date: y + '-01-01', base: 'USD', quote: 'KZT', rate: yearly[y], source: 'nbk-avg' }));
    fxRates.forEach(r => { const i = fx.findIndex(x => x.date === r.date); if (i >= 0) fx.splice(i, 1); fx.push(r); });
    if (reportRate) fx.push({ date: reportDate, base: 'USD', quote: 'KZT', rate: reportRate, source: 'nbk' });
    fx.sort((a, b) => a.date < b.date ? -1 : 1);

    // название брокера — из инструкции шаблона («…из выписок АО «Имя»»), если есть
    let broker = '';
    const instr = book.sheets['Инструкция'];
    if (instr) Object.values(instr.cells).some(v => { const m = /выпис\S*\s+(?:АО|ТОО)?\s*«([^»]+)»/i.exec(String(v)); if (m) broker = m[1]; return !!m; });

    const counts = { trades: txs.filter(t => t.type === 'buy' || t.type === 'sell').length,
      cash: txs.filter(t => t.type === 'deposit' || t.type === 'withdraw').length,
      payouts: txs.filter(t => t.type === 'dividend' || t.type === 'coupon').length, assets: assets.length };
    return { ok: true, report: { date: reportDate, cashActual, rate: reportRate, broker, recon, counts },
      assets, txs, prices, fx, warnings, skipped };
  }

  /*
   * Применяет импорт к состоянию приложения: операции выбранного счёта заменяются историей из шаблона,
   * остальные счета не трогаются. Бумаги добавляются; уже настроенные в приложении (тикер, биржа) сохраняются.
   */
  function applyImport(state, imp, accountId) {
    const out = Object.assign({}, state);
    out.txs = state.txs.filter(t => t.accountId !== accountId && t.toAccountId !== accountId).concat(imp.txs.map(t => Object.assign({}, t, { accountId })));
    const ids = new Set(state.assets.map(a => a.id));
    out.assets = state.assets.concat(imp.assets.filter(a => !ids.has(a.id)));
    out.prices = Object.assign({}, state.prices);
    Object.keys(imp.prices).forEach(id => {
      const incoming = imp.prices[id], dates = new Set(incoming.map(p => p.date));
      out.prices[id] = (state.prices[id] || []).filter(p => !dates.has(p.date)).concat(incoming)
        .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    });
    const key = r => r.date + r.base + r.quote;
    const fxKeys = new Set(imp.fx.map(key));
    out.fx = state.fx.filter(r => !fxKeys.has(key(r))).concat(imp.fx);
    out.seq = Math.max(state.seq || 0, ...out.txs.map(t => t.seq || 0));
    return out;
  }

  /* ---------- отчёт брокера по комиссиям ---------- */

  // «Отчет по комиссиям» (Alatau City Invest): лист «ОТЧЕТ», строки сделок с комиссией брокера,
  // итоги комиссий третьих сторон (биржи, депозитарии, кастодиан) и начислено/оплачено за период
  function isFeeReport(book) {
    const sh = book && book.sheets && book.sheets['ОТЧЕТ'];
    return !!(sh && /отчет по комиссиям/i.test(String(sh.cells.A1 || '')));
  }

  function hash(s) {
    let h1 = 5381, h2 = 52711;
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = (h1 * 33) ^ c; h2 = (h2 * 33) ^ c; }
    return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
  }

  /*
   * Комиссии из отчёта → операции «Комиссия» в тенге.
   * Комиссия брокера — отдельной операцией на дату сделки, комиссии третьих сторон — итогом за год
   * на конец периода (для текущего года — на opts.today). У каждой операции постоянный id
   * из содержимого строки, поэтому повторная загрузка того же или обновлённого отчёта не создаёт дублей.
   * Возвращает { ok, error, year, from, to, txs, totals: { broker, third, accrued, paid, debtStart, debtEnd }, warnings }
   */
  function feeReportToTxs(book, opts) {
    opts = opts || {};
    if (!isFeeReport(book)) return { ok: false, error: 'Это не отчёт брокера по комиссиям' };
    const sh = book.sheets['ОТЧЕТ'], cell = (c, r) => sh.cells[c + r];
    let from = null, to = null;
    const totals = { broker: 0, third: 0, accrued: null, paid: null, debtStart: null, debtEnd: null };
    const txs = [], seen = {}, warnings = [], third = [];
    const KZT = v => money(v, 'KZT');
    for (let r = 1; r <= sh.maxRow; r++) {
      const a = cell('A', r), b = cell('B', r), h = toNum(cell('H', r));
      if (typeof b === 'string' && /отчет составлен на/i.test(b)) {
        const m = String(cell('C', r) || '').match(/(\d\d\.\d\d\.\d{4})\s*-\s*(\d\d\.\d\d\.\d{4})/);
        if (m) { from = C.parseDateAny(m[1]); to = C.parseDateAny(m[2]); }
      }
      if (typeof a === 'string' && /^\d\d\.\d\d\.\d{4}$/.test(a.trim())) {
        if (!(h > 0)) continue;
        const date = C.parseDateAny(a.trim());
        const kind = String(b || '').replace(/\s+/g, ' ').trim();
        const sec = String(cell('C', r) || '').trim();
        const ticker = sec.replace(/-[A-Z]{2}[A-Z0-9]{9}\d$/, '').replace(/_US$|^US_|_+$/g, '').replace(/_/g, '').trim() || sec;
        const base = [date, kind, sec, cell('D', r), cell('E', r), h].join('|');
        seen[base] = (seen[base] || 0) + 1;
        txs.push({ id: 'fee-' + hash(base + '|' + seen[base]), type: 'fee', date, currency: 'KZT', amount: KZT(h),
          note: 'Комиссия брокера: ' + kind.toLowerCase().replace(/\s*\/.*$/, '') + ' ' + ticker });
        totals.broker += h;
        continue;
      }
      if (typeof a !== 'string') continue;
      const label = a.replace(/\s+/g, ' ').trim();
      if (/^(Сумма комиссии|Комиссия|Прочие комиссии)/.test(label) && h > 0) third.push([label, h]);
      if (/^Итого комиссия Брокера/i.test(label) && h != null && Math.abs(h - totals.broker) > 0.005) {
        warnings.push(`Сумма комиссий брокера по строкам (${totals.broker.toFixed(2)} ₸) не совпадает с итогом в отчёте (${h} ₸)`);
      }
      const v = toNum(cell('B', r));
      if (/^Задолженность на начало/.test(label)) totals.debtStart = v;
      if (/^Начислено за период/.test(label)) totals.accrued = v;
      if (/^Оплачено за период/.test(label)) totals.paid = v;
      if (/^Задолженность на конец/.test(label)) totals.debtEnd = v;
    }
    if (!from || !to) return { ok: false, error: 'В отчёте не найден период' };
    const year = from.slice(0, 4);
    const today = opts.today || C.today();
    const thirdDate = to < today ? to : today;
    third.forEach(([label, v]) => {
      const who = label.replace(/^(Сумма комиссии|Комиссия)\s*/i, '').replace(/^АО\s*/, '');
      txs.push({ id: 'fee-' + hash('third|' + from + '|' + label), type: 'fee', date: thirdDate, currency: 'KZT', amount: KZT(v),
        note: 'Комиссии за ' + year + ' год: ' + (who || label) });
      totals.third += v;
    });
    if (totals.accrued != null && Math.abs(totals.broker + totals.third - totals.accrued) > 0.05) {
      warnings.push(`Начислено в отчёте ${totals.accrued} ₸, а по строкам ${(totals.broker + totals.third).toFixed(2)} ₸`);
    }
    return { ok: true, year, from, to, txs, totals, warnings };
  }

  const RECON = /^Сверка с выпиской брокера/;

  /*
   * Добавляет комиссии из отчёта на счёт. Операция с тем же id заменяется (итоги текущего года растут),
   * новые — добавляются. На сумму прибавки уменьшается «сверка с выпиской» в тенге — разовая комиссия,
   * которой импорт шаблона закрывал разницу остатка денег с выпиской; если она исчерпана, она удаляется.
   * Возвращает { state, added, updated, same, recon: { before, after } }
   */
  function applyFeeReport(state, rep, accountId, opts) {
    opts = opts || {};
    const byId = {};
    state.txs.forEach(t => { byId[t.id] = t; });
    let added = 0, updated = 0, same = 0, delta = 0, seq = state.seq || 0;
    const repl = {}, fresh = [];
    rep.txs.forEach(t => {
      const old = byId[t.id];
      if (!old) { fresh.push(Object.assign({}, t, { accountId, seq: ++seq })); added++; delta += t.amount; return; }
      if (old.amount === t.amount && old.date === t.date) { same++; return; }
      repl[t.id] = Object.assign({}, old, { date: t.date, amount: t.amount, note: t.note });
      updated++; delta += t.amount - old.amount;
    });
    let txs = state.txs.map(t => repl[t.id] || t).concat(fresh);
    const reconTxs = txs.filter(t => t.type === 'fee' && t.accountId === accountId && t.currency === 'KZT' && RECON.test(t.note || ''));
    const before = reconTxs.reduce((s, t) => s + t.amount, 0);
    let left = Math.max(0, delta);
    const cut = {};
    reconTxs.forEach(t => { const take = Math.min(left, t.amount); left -= take; cut[t.id] = t.amount - take; });
    txs = txs.filter(t => !(t.id in cut) || cut[t.id] > 0).map(t => (t.id in cut) ? Object.assign({}, t, { amount: cut[t.id] }) : t);
    const after = reconTxs.reduce((s, t) => s + (cut[t.id] || 0), 0);
    return { state: Object.assign({}, state, { txs, seq }), added, updated, same, recon: { before, after } };
  }

  const api = { templateToData, applyImport, KNOWN, isFeeReport, feeReportToTxs, applyFeeReport };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PortfolioTemplate = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
