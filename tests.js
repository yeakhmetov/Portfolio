/*
 * Тесты ядра расчётов.
 * Node:    node tests.js
 * Браузер: откройте tests.html
 */
(function (root) {
  'use strict';
  var C = typeof require !== 'undefined' ? require('./core.js') : root.PortfolioCore;
  var QT = typeof require !== 'undefined' ? require('./quotes.js') : root.PortfolioQuotes;
  var results = [], pending = [];

  // тест может вернуть Promise — тогда результат фиксируется по его завершении
  function test(name, fn) {
    var slot = { name: name, ok: true };
    results.push(slot);
    try {
      var r = fn();
      if (r && typeof r.then === 'function') pending.push(r.then(null, function (e) { slot.ok = false; slot.error = e.message; }));
    } catch (e) { slot.ok = false; slot.error = e.message; }
  }
  function eq(actual, expected, what) {
    if (actual !== expected) throw new Error((what || 'значение') + ': ожидалось ' + JSON.stringify(expected) + ', получено ' + JSON.stringify(actual));
  }
  function near(actual, expected, eps, what) {
    if (actual == null || Math.abs(actual - expected) > eps) throw new Error((what || 'значение') + ': ожидалось ≈' + expected + ', получено ' + actual);
  }

  var Q = C.parseQty;
  var M = function (s) { return C.parseMoney(s, 'KZT'); };

  /* ---------- числа ---------- */

  test('parseQty: целые, дробные, запятая, 8 знаков', function () {
    eq(Q('10'), 1000000000);
    eq(Q('1,5'), 150000000);
    eq(Q('0.00000001'), 1);
    eq(Q('0.000000015'), 2, 'округление 9-го знака');
    eq(Q('abc'), null);
    eq(Q(''), null);
  });

  test('parseMoney и formatMoney для KZT и JPY', function () {
    eq(M('1 234,56'), 123456);
    eq(C.parseMoney('1000', 'JPY'), 1000, 'у иены нет дробной части');
    eq(C.formatMoney(123456, 'KZT'), '1 234,56 ₸');
    eq(C.formatMoney(-5000, 'USD'), '−50,00 $');
  });

  test('mulDivRound точен на больших числах', function () {
    eq(C.mulDivRound(9007199254740, 99999999, 100000000), 9007199164668);
    eq(C.mulDivRound(5, 1, 2), 3, 'половина округляется вверх');
  });

  test('calcAmount: акция и облигация (% от номинала)', function () {
    eq(C.calcAmount(Q('10'), 2000, 'KZT'), M('20000'));
    eq(C.calcAmount(Q('3'), 98.5, 'KZT', { class: 'bond', faceValue: 1000 }), M('2955'));
    eq(C.calcAmount(Q('0.5'), 60000.12, 'USD'), 3000006);
  });

  /* ---------- сценарий из промпта ---------- */

  function scenario() {
    return [
      { id: 'd', accountId: 'A', type: 'deposit', date: '2024-01-01', amount: M('50000'), currency: 'KZT' },
      { id: 'b1', accountId: 'A', assetId: 'KCEL', type: 'buy', date: '2024-01-10', quantity: Q('10'), amount: M('20000'), fee: M('100'), currency: 'KZT' },
      { id: 'b2', accountId: 'A', assetId: 'KCEL', type: 'buy', date: '2024-03-01', quantity: Q('10'), amount: M('22000'), fee: M('100'), currency: 'KZT' },
      { id: 's1', accountId: 'A', assetId: 'KCEL', type: 'sell', date: '2024-06-01', quantity: Q('15'), amount: M('37500'), fee: M('150'), currency: 'KZT' },
      { id: 'dv', accountId: 'A', assetId: 'KCEL', type: 'dividend', date: '2024-07-01', amount: M('500'), tax: M('25'), currency: 'KZT' },
      { id: 'sp', accountId: 'A', assetId: 'KCEL', type: 'split', date: '2024-08-01', ratio: { num: 2, den: 1 }, currency: 'KZT' }
    ];
  }

  test('FIFO: покупка → докупка → частичная продажа → дивиденд → сплит', function () {
    var s = C.computePortfolio(scenario(), { method: 'fifo' });
    var p = s.positions['A|KCEL'];
    eq(s.errors.length, 0, 'ошибок');
    eq(p.qty, Q('10'), 'количество после сплита 2:1');
    eq(p.cost, M('11050'), 'себестоимость остатка (5 шт. из 2-го лота)');
    eq(p.realized, M('6200'), 'реализованная прибыль: 37350 − (20100 + 11050)');
    eq(p.income, M('475'), 'дивиденд за вычетом налога');
    eq(p.fees, M('350'), 'комиссии');
    eq(s.cash.A.KZT, M('45625'), 'деньги на счёте');
  });

  test('Средневзвешенная: тот же сценарий', function () {
    var s = C.computePortfolio(scenario(), { method: 'avg' });
    var p = s.positions['A|KCEL'];
    eq(p.qty, Q('10'));
    eq(p.cost, M('10550'), 'себестоимость остатка: 42200 × 5/20');
    eq(p.realized, M('5700'), 'реализованная прибыль: 37350 − 31650');
  });

  test('Нельзя продать больше, чем есть', function () {
    var txs = scenario().slice(0, 3);
    txs.push({ id: 'x', accountId: 'A', assetId: 'KCEL', type: 'sell', date: '2024-06-01', quantity: Q('25'), amount: M('50000'), currency: 'KZT' });
    var s = C.computePortfolio(txs);
    eq(s.errors.length, 1, 'ошибок');
    eq(s.positions['A|KCEL'].qty, Q('20'), 'позиция не изменилась');
  });

  test('Продажа всего остатка обнуляет себестоимость', function () {
    var txs = [
      { accountId: 'A', assetId: 'X', type: 'buy', date: '2024-01-01', quantity: Q('3'), amount: 1000, fee: 1, currency: 'KZT' },
      { accountId: 'A', assetId: 'X', type: 'sell', date: '2024-01-02', quantity: Q('1'), amount: 400, currency: 'KZT' },
      { accountId: 'A', assetId: 'X', type: 'sell', date: '2024-01-03', quantity: Q('2'), amount: 800, currency: 'KZT' }
    ];
    var p = C.computePortfolio(txs).positions['A|X'];
    eq(p.qty, 0); eq(p.cost, 0); eq(p.realized, 1200 - 1001);
  });

  test('Порядок операций: по дате, при равной дате — по порядку ввода', function () {
    var txs = [
      { accountId: 'A', assetId: 'X', type: 'sell', date: '2024-02-01', quantity: Q('1'), amount: 100, currency: 'KZT', seq: 2 },
      { accountId: 'A', assetId: 'X', type: 'buy', date: '2024-02-01', quantity: Q('1'), amount: 50, currency: 'KZT', seq: 1 }
    ];
    var s = C.computePortfolio(txs);
    eq(s.errors.length, 0);
    eq(s.positions['A|X'].realized, 50);
  });

  test('Перевод бумаг между счетами сохраняет себестоимость и дату', function () {
    var txs = [
      { accountId: 'A', assetId: 'X', type: 'buy', date: '2024-01-01', quantity: Q('4'), amount: 4000, currency: 'KZT' },
      { accountId: 'A', toAccountId: 'B', assetId: 'X', type: 'transfer', date: '2024-02-01', quantity: Q('1'), currency: 'KZT' }
    ];
    var s = C.computePortfolio(txs);
    eq(s.positions['A|X'].qty, Q('3'));
    eq(s.positions['A|X'].cost, 3000);
    eq(s.positions['B|X'].qty, Q('1'));
    eq(s.positions['B|X'].cost, 1000);
    eq(s.positions['B|X'].firstDate, '2024-01-01');
  });

  /* ---------- валюты ---------- */

  var fx = C.makeFx([
    { date: '2024-01-01', base: 'USD', quote: 'KZT', rate: 480 },
    { date: '2024-06-01', base: 'USD', quote: 'KZT', rate: 500 },
    { date: '2024-06-01', base: 'EUR', quote: 'KZT', rate: 540 },
    { date: '2024-06-01', base: 'JPY', quote: 'KZT', rate: 3.3 }
  ]);

  test('Курсы: курс на дату, обратный и кросс-курс', function () {
    eq(fx.convert(10000, 'USD', 'KZT', '2024-03-01'), M('48000'), '$100 в марте');
    eq(fx.convert(10000, 'USD', 'KZT', '2024-07-01'), M('50000'), '$100 в июле');
    eq(fx.convert(M('50000'), 'KZT', 'USD', '2024-07-01'), 10000, 'обратный курс');
    near(fx.rate('EUR', 'USD', '2024-07-01'), 1.08, 1e-12, 'EUR/USD через тенге');
    eq(fx.convert(1000, 'JPY', 'KZT', '2024-07-01'), M('3300'), 'иена без дробной части');
    eq(fx.convert(100, 'GBP', 'KZT', '2024-07-01'), null, 'нет курса');
  });

  test('Мультивалютная сводка в базовой валюте', function () {
    var txs = [
      { accountId: 'A', assetId: 'KCEL', type: 'buy', date: '2024-06-02', quantity: Q('10'), amount: M('20000'), currency: 'KZT' },
      { accountId: 'A', assetId: 'AAPL', type: 'buy', date: '2024-06-02', quantity: Q('1'), amount: 20000, currency: 'USD' }
    ];
    var st = C.computePortfolio(txs);
    var sum = C.summarize(st, {
      assets: { KCEL: { id: 'KCEL', class: 'stock' }, AAPL: { id: 'AAPL', class: 'stock' } },
      prices: { KCEL: { price: 2100 }, AAPL: { price: 220 } },
      fx: fx, base: 'KZT', date: '2024-07-01', accounts: { A: { trackCash: false } }
    });
    eq(sum.value, M('21000') + M('110000'), 'стоимость: 21 000 ₸ + $220 × 500');
    eq(sum.invested, M('20000') + M('100000'), 'вложено');
    eq(sum.unrealized, M('11000'));
    eq(sum.missingPrices.length, 0);
    eq(sum.byKey(function (r) { return r.currency; }).USD, M('110000'));
  });

  test('Счёт без пополнений: покупки не уводят стоимость портфеля в минус', function () {
    var txs = [
      { accountId: 'A', assetId: 'KCEL', type: 'buy', date: '2024-06-02', quantity: Q('10'), amount: M('20000'), fee: M('20'), currency: 'KZT' },
      { accountId: 'A', assetId: 'KCEL', type: 'dividend', date: '2024-06-03', amount: M('500'), tax: M('25'), currency: 'KZT' }
    ];
    var st = C.computePortfolio(txs);
    var sum = C.summarize(st, { assets: {}, prices: { KCEL: { price: 2000 } }, fx: fx, base: 'KZT', date: '2024-07-01', accounts: { A: {} } });
    eq(sum.cash, 0, 'отрицательный остаток не учитывается');
    eq(sum.total, M('20000'), 'стоимость = бумаги');
    var flows = C.investorFlows(txs, sum, { fx: fx, base: 'KZT', date: '2024-07-01', cash: st.cash });
    var contributed = -flows.slice(0, -1).reduce(function (s, f) { return s + f.amount; }, 0);
    eq(contributed, M('19545'), 'вложено: покупка с комиссией минус дивиденд');
  });

  /* ---------- XIRR ---------- */

  test('XIRR: ровно год, +10 %', function () {
    near(C.xirr([{ date: '2021-01-01', amount: -1000 }, { date: '2022-01-01', amount: 1100 }]), 0.1, 1e-9);
  });

  test('XIRR: пример из документации Excel (37,34 %)', function () {
    near(C.xirr([
      { date: '2008-01-01', amount: -10000 },
      { date: '2008-03-01', amount: 2750 },
      { date: '2008-10-30', amount: 4250 },
      { date: '2009-02-15', amount: 3250 },
      { date: '2009-04-01', amount: 2750 }
    ]), 0.373362535, 1e-6);
  });

  test('XIRR: убыток и вырожденные случаи', function () {
    near(C.xirr([{ date: '2021-01-01', amount: -1000 }, { date: '2022-01-01', amount: 500 }]), -0.5, 1e-9);
    eq(C.xirr([{ date: '2021-01-01', amount: -1000 }]), null, 'один поток');
    eq(C.xirr([{ date: '2021-01-01', amount: -1000 }, { date: '2022-01-01', amount: -5 }]), null, 'нет возвратов');
  });

  test('Потоки инвестора: пополнения + остаток на конец', function () {
    var txs = scenario();
    var st = C.computePortfolio(txs);
    var ctx = { assets: { KCEL: { id: 'KCEL', class: 'stock' } }, prices: { KCEL: { price: 1300 } }, fx: fx, base: 'KZT', date: '2025-01-01' };
    var sum = C.summarize(st, ctx);
    var flows = C.investorFlows(txs, sum, { fx: fx, base: 'KZT', date: '2025-01-01', cash: st.cash });
    eq(flows.length, 2, 'пополнение и итог');
    eq(flows[0].amount, -M('50000'));
    eq(flows[1].amount, M('13000') + M('45625'), 'бумаги + деньги');
  });

  test('Потоки инвестора: счёт без пополнений — покупки и продажи', function () {
    var txs = scenario().slice(1);
    var st = C.computePortfolio(txs);
    var sum = C.summarize(st, { assets: {}, prices: { KCEL: { price: 1300 } }, fx: fx, base: 'KZT', date: '2025-01-01' });
    var flows = C.investorFlows(txs, sum, { fx: fx, base: 'KZT', date: '2025-01-01', cash: st.cash });
    eq(flows.map(function (f) { return f.amount; }).join(','),
      [-M('20100'), -M('22100'), M('37350'), M('475'), M('13000')].join(','));
  });

  /* ---------- ребалансировка ---------- */

  test('Ребалансировка: денег хватает', function () {
    var r = C.rebalance({ stock: 600000, bond: 400000 }, { stock: 50, bond: 50 }, 200000);
    eq(r.buys.bond, 200000); eq(r.buys.stock, undefined);
    near(r.deviation.stock.diff, 0.1, 1e-12);
  });

  test('Ребалансировка: денег не хватает — пропорционально', function () {
    var r = C.rebalance({ stock: 600000, bond: 400000, cash: 0 }, { stock: 40, bond: 40, cash: 20 }, 100000);
    // цель при 1 100 000: акции 440 000, облигации 440 000, кэш 220 000 → дефициты 40 000 и 220 000
    eq(r.buys.bond + r.buys.cash, 100000, 'распределено всё');
    eq(r.buys.stock, undefined);
    eq(r.buys.bond, Math.floor(40000 * 100000 / 260000));
  });

  /* ---------- импорт и экспорт ---------- */

  test('parseCSV: разделитель, кавычки, BOM, CRLF', function () {
    var r = C.parseCSV('﻿Дата;Заметка;Сумма\r\n2024-01-02;"Текст; с ""кавычками""";1 000,50\r\n\r\n');
    eq(r.delimiter, ';');
    eq(r.rows.length, 2, 'пустые строки пропускаются');
    eq(r.rows[1][1], 'Текст; с "кавычками"');
    eq(r.rows[1][2], '1 000,50');
    eq(C.parseCSV('a,b\n1,2').delimiter, ',');
  });

  test('parseDateAny: разные форматы и неверные даты', function () {
    eq(C.parseDateAny('2024-03-05'), '2024-03-05');
    eq(C.parseDateAny('05.03.2024'), '2024-03-05');
    eq(C.parseDateAny('5/3/24'), '2024-03-05');
    eq(C.parseDateAny('2024-03-05T10:20:00Z'), '2024-03-05');
    eq(C.parseDateAny('31.02.2024'), null, '31 февраля');
    eq(C.parseDateAny('вчера'), null);
  });

  test('Распознавание типов операций и колонок', function () {
    eq(C.detectType('Покупка'), 'buy');
    eq(C.detectType('SELL'), 'sell');
    eq(C.detectType('Дивиденды'), 'dividend');
    eq(C.detectType('Купонный доход'), 'coupon');
    eq(C.detectType('что-то'), null);
    var m = C.guessMapping(['Дата сделки', 'Операция', 'Тикер', 'Кол-во', 'Цена', 'Комиссия', 'Валюта']);
    eq(m.date, 0); eq(m.type, 1); eq(m.ticker, 2); eq(m.quantity, 3); eq(m.price, 4); eq(m.fee, 5); eq(m.currency, 6);
    eq(m.amount, undefined);
  });

  test('csvToTxs: сумма из цены, новый актив, ошибки по строкам', function () {
    var p = C.parseCSV('Дата;Тип;Тикер;Количество;Цена;Комиссия\n10.01.2024;Покупка;kcel;10;2 000,5;15\n11.01.2024;Непонятно;KCEL;1;1;0\n12.01.2024;Продажа;KCEL;;2100;0');
    var map = C.guessMapping(p.rows[0]);
    var res = C.csvToTxs(p.rows.slice(1), map, { accounts: [{ id: 'A', name: 'Freedom' }], assets: [], defaultAccountId: 'A', defaultCurrency: 'KZT' });
    eq(res.txs.length, 1, 'одна корректная строка');
    eq(res.errors.length, 2);
    eq(res.errors[0].row, 2); eq(res.errors[1].row, 3);
    eq(res.newAssets.length, 1); eq(res.newAssets[0].ticker, 'KCEL');
    var t = res.txs[0];
    eq(t.amount, M('20005')); eq(t.fee, M('15')); eq(t.quantity, Q('10')); eq(t.assetId, res.newAssets[0].id);
  });

  function scenarioData() {
    return {
      accounts: [{ id: 'A', name: 'Freedom', currency: 'KZT' }, { id: 'B', name: 'Halyk', currency: 'KZT' }],
      assets: [{ id: 'KCEL', ticker: 'KCEL', name: 'Kcell', class: 'stock', currency: 'KZT' }],
      txs: scenario().concat([
        { id: 't', accountId: 'A', toAccountId: 'B', assetId: 'KCEL', type: 'transfer', date: '2024-09-01', quantity: Q('2'), currency: 'KZT', note: 'на ИИС; тест' }
      ]),
      prices: { KCEL: [{ date: '2024-09-01', price: 1300, source: 'manual' }] }, fx: [], targets: { stock: 100 }, settings: { baseCurrency: 'KZT' }, seq: 7
    };
  }

  test('Экспорт CSV → импорт CSV даёт тот же портфель', function () {
    var data = scenarioData();
    var csv = C.txsToCSV(data);
    var p = C.parseCSV(csv);
    eq(p.rows.length, data.txs.length + 1, 'заголовок + операции');
    var res = C.csvToTxs(p.rows.slice(1), C.guessMapping(p.rows[0]), { accounts: data.accounts, assets: data.assets, defaultAccountId: 'A' });
    eq(res.errors.length, 0, 'ошибок импорта' + (res.errors[0] ? ': ' + res.errors[0].message : ''));
    var a = C.computePortfolio(data.txs), b = C.computePortfolio(res.txs);
    ['A|KCEL', 'B|KCEL'].forEach(function (k) {
      ['qty', 'cost', 'realized', 'income'].forEach(function (f) { eq(b.positions[k][f], a.positions[k][f], k + ' ' + f); });
    });
    eq(JSON.stringify(b.cash), JSON.stringify(a.cash), 'деньги');
    eq(res.txs[6].note, 'на ИИС; тест', 'заметка с разделителем');
  });

  test('Резервная копия JSON: сохранение и восстановление без потерь', function () {
    var data = scenarioData();
    var back = JSON.parse(JSON.stringify(C.makeBackup(data, '2024-10-01T00:00:00Z')));
    var v = C.validateBackup(back);
    eq(v.ok, true, v.error);
    eq(v.counts.txs, 7);
    eq(JSON.stringify(v.data), JSON.stringify(C.makeBackup(data).data), 'данные совпадают');
  });

  test('Резервная копия: повреждённые файлы отклоняются', function () {
    eq(C.validateBackup(null).ok, false);
    eq(C.validateBackup({ app: 'rashody', data: {} }).ok, false, 'чужое приложение');
    eq(C.validateBackup({ app: 'portfolio', version: 2, data: {} }).ok, false, 'новая версия');
    var bad = C.makeBackup(scenarioData());
    bad.data.txs[1].amount = 12.5;
    eq(C.validateBackup(bad).ok, false, 'дробная сумма');
  });

  test('Объединение: дубликаты пропускаются, одинаковые тикеры склеиваются', function () {
    var cur = scenarioData();
    var inc = {
      accounts: [{ id: 'A', name: 'Freedom' }],
      assets: [{ id: 'other-kcel', ticker: 'kcel', name: 'Kcell' }, { id: 'HSBK', ticker: 'HSBK', name: 'Halyk' }],
      txs: [cur.txs[1], { id: 'n1', accountId: 'A', assetId: 'other-kcel', type: 'buy', date: '2024-10-01', quantity: Q('1'), amount: 100, currency: 'KZT', seq: 1 }],
      prices: { 'other-kcel': [{ date: '2024-09-01', price: 1 }, { date: '2024-10-01', price: 1400 }] }
    };
    var r = C.mergeData(cur, inc);
    eq(r.skipped, 1); eq(r.added.txs, 1); eq(r.added.assets, 1); eq(r.added.accounts, 0);
    var n1 = r.data.txs.find(function (t) { return t.id === 'n1'; });
    eq(n1.assetId, 'KCEL', 'ссылка на существующий актив');
    eq(n1.seq, 8, 'порядок после существующих');
    eq(r.data.prices.KCEL.length, 2); eq(r.data.prices.KCEL[0].price, 1300, 'своя цена на ту же дату не перезаписана');
  });

  /* ---------- котировки ---------- */

  var T = function (s) { return Date.parse(s); };
  var kcel = { id: 'kcel', ticker: 'KCEL', class: 'stock', currency: 'KZT', exchange: 'KASE' };
  var kap = { id: 'kap', ticker: 'KAP', class: 'stock', currency: 'USD', exchange: 'AIX' };
  var btc = { id: 'btc', ticker: 'BTC', class: 'crypto', currency: 'USD', exchange: 'CRYPTO' };
  var sber = { id: 'sber', ticker: 'SBER', class: 'stock', currency: 'RUB', exchange: 'MOEX' };
  var aapl = { id: 'aapl', ticker: 'AAPL', class: 'stock', currency: 'USD', exchange: 'NASDAQ' };
  var hsbk = { id: 'hsbk', ticker: 'HSBK', class: 'stock', currency: 'KZT', exchange: 'KASE' };

  test('Котировки: маршруты и тикеры источников', function () {
    eq(QT.routeFor(kcel).join(), 'kase,aix,global');
    eq(QT.routeFor(kap).join(), 'aix,kase,global');
    eq(QT.routeFor(btc).join(), 'crypto');
    eq(QT.routeFor({ class: 'deposit', exchange: 'OTC' }).length, 0, 'депозит');
    eq(QT.routeFor(Object.assign({}, kcel, { quoteSource: 'manual' })).length, 0, 'только вручную');
    eq(QT.symbolFor(btc, 'crypto'), 'bitcoin');
    eq(QT.symbolFor(Object.assign({}, btc, { quoteSymbol: 'Wrapped-Bitcoin' }), 'crypto'), 'wrapped-bitcoin');
    eq(QT.symbolFor(Object.assign({}, kcel, { quoteSymbol: 'kcel_old' }), 'kase'), 'KCEL_OLD');
  });

  test('Котировки: часы торгов KASE и последняя цена закрытия', function () {
    eq(QT.isOpen('KASE', T('2026-09-28T07:00:00Z')), true, 'пн 12:00 по Астане');
    eq(QT.isOpen('KASE', T('2026-09-28T13:00:00Z')), false, 'пн 18:00');
    eq(QT.isOpen('KASE', T('2026-09-26T07:00:00Z')), false, 'суббота');
    eq(QT.lastClose('KASE', T('2026-09-28T13:00:00Z')), T('2026-09-28T12:00:00Z'));
    eq(QT.lastClose('KASE', T('2026-09-27T10:00:00Z')), T('2026-09-25T12:00:00Z'), 'в воскресенье — пятница');
    eq(QT.lastClose('KASE', T('2026-09-28T07:00:00Z')), null, 'рынок открыт');
    eq(QT.isOpen('CRYPTO', T('2026-09-26T03:00:00Z')), true, 'крипта всегда');
  });

  test('Котировки: когда обновлять цену', function () {
    var rec = function (iso) { return { price: 1, fetchedAt: iso }; };
    eq(QT.needsRefresh(kcel, null, T('2026-09-28T07:00:00Z'), 15), true, 'нет цены');
    eq(QT.needsRefresh(kcel, rec('2026-09-28T06:50:00Z'), T('2026-09-28T07:00:00Z'), 15), false, '10 мин назад, рынок открыт');
    eq(QT.needsRefresh(kcel, rec('2026-09-28T06:40:00Z'), T('2026-09-28T07:00:00Z'), 15), true, '20 мин назад');
    eq(QT.needsRefresh(kcel, rec('2026-09-28T12:10:00Z'), T('2026-09-28T15:00:00Z'), 15), true, 'нет цены закрытия с учётом задержки');
    eq(QT.needsRefresh(kcel, rec('2026-09-28T12:30:00Z'), T('2026-09-28T15:00:00Z'), 15), false, 'цена закрытия уже есть');
    eq(QT.needsRefresh(kcel, rec('2026-09-25T13:00:00Z'), T('2026-09-27T10:00:00Z'), 15), false, 'выходные');
    eq(QT.needsRefresh(btc, rec('2026-09-27T09:40:00Z'), T('2026-09-27T10:00:00Z'), 15), true, 'крипта в выходные');
    eq(QT.isStale(kcel, rec('2026-09-24T12:30:00Z'), T('2026-09-28T07:00:00Z')), true, 'с четверга');
    eq(QT.isStale(kcel, rec('2026-09-25T12:30:00Z'), T('2026-09-27T10:00:00Z')), false, 'с пятницы в выходные');
  });

  test('Котировки: разбор ответов MOEX, CoinGecko, Twelve Data, курсов', function () {
    var moex = QT.parseMoex({
      marketdata: { columns: ['SECID', 'BOARDID', 'LAST', 'LCURRENTPRICE', 'MARKETPRICE', 'UPDATETIME', 'SYSTIME'],
        data: [['SBER', 'SMAL', 300.1, null, null, '10:00:00', '2026-09-28 10:00:05'], ['SBER', 'TQBR', null, 301.5, null, '18:39:59', '2026-09-28 18:40:01']] },
      securities: { columns: ['SECID', 'BOARDID', 'PREVPRICE', 'PREVLEGALCLOSEPRICE', 'CURRENCYID'], data: [['SBER', 'TQBR', 299, 299, 'SUR'], ['SBER', 'SMAL', 299, 299, 'SUR']] }
    });
    eq(moex.SBER.price, 301.5, 'основной режим торгов TQBR'); eq(moex.SBER.currency, 'RUB'); eq(moex.SBER.date, '2026-09-28'); eq(moex.SBER.time, '18:40');
    var cg = QT.parseCoinGecko({ bitcoin: { usd: 65000.5, last_updated_at: 1790000000 } }, ['bitcoin', 'nocoin'], 'USD');
    eq(cg.bitcoin.price, 65000.5); eq(cg.nocoin, undefined);
    eq(QT.parseTwelveData({ price: '190.10' }, ['AAPL']).AAPL.price, 190.1);
    eq(QT.parseTwelveData({ AAPL: { price: '190' }, SPY: { code: 400 } }, ['AAPL', 'SPY']).SPY, undefined);
    var threw = false; try { QT.parseTwelveData({ status: 'error', message: 'bad key' }, ['AAPL']); } catch (e) { threw = e.message === 'bad key'; }
    eq(threw, true, 'ошибка ключа');
    var er = QT.parseErApi({ result: 'success', base_code: 'USD', time_last_update_unix: 1790000000, rates: { USD: 1, KZT: 480, EUR: 0.9 } }, ['USD', 'EUR', 'KZT']);
    eq(er.length, 2); eq(er[0].rate, 480); eq(er[1].base, 'EUR'); eq(er[1].rate, 533.333333);
  });

  function mockFetch(routes, log) {
    return function (url, init) {
      if (log) log.push({ url: url, init: init });
      for (var i = 0; i < routes.length; i++) if (routes[i][0].test(decodeURIComponent(url))) {
        var r = routes[i][1]; var v = typeof r === 'function' ? r(decodeURIComponent(url)) : r;
        return v instanceof Error ? Promise.reject(v) : Promise.resolve(v);
      }
      return Promise.reject(new Error('нет сети: ' + url));
    };
  }
  var proxyAnswer = function (url) {
    var q = [];
    if (/kase:KCEL/.test(url)) q.push({ symbol: 'kase:KCEL', price: 2150.5, currency: 'KZT', date: '2026-09-28', time: '12:31' });
    if (/kase:KAP/.test(url)) q.push({ symbol: 'kase:KAP', price: 16000, currency: 'KZT', date: '2026-09-28' });
    if (/kase:AAPL/.test(url)) q.push({ symbol: 'kase:AAPL', price: 95000, currency: 'KZT', date: '2026-09-28' });
    return { quotes: q };
  };

  test('Котировки: основной источник, запасные и пересчёт валюты', function () {
    var log = [];
    return QT.refreshQuotes({
      assets: [kcel, kap, btc, sber, aapl, hsbk],
      settings: { proxyUrl: 'https://p.example/', proxyToken: 'secret' },
      now: T('2026-09-28T07:00:00Z'),
      fxRate: function (from, to) { return from === 'KZT' && to === 'USD' ? 1 / 500 : null; },
      fetchJson: mockFetch([
        [/p\.example\/quotes/, proxyAnswer],
        [/coingecko/, { bitcoin: { usd: 65000 } }],
        [/moex/, { marketdata: { columns: ['SECID', 'BOARDID', 'LAST'], data: [['SBER', 'TQBR', 301]] }, securities: { columns: ['SECID', 'BOARDID', 'CURRENCYID'], data: [['SBER', 'TQBR', 'SUR']] } }]
      ], log)
    }).then(function (r) {
      var by = {}; r.updates.forEach(function (u) { by[u.assetId] = u; });
      eq(r.requested, 6);
      eq(by.kcel.price, 2150.5); eq(by.kcel.source, 'kase'); eq(by.kcel.time, '12:31');
      eq(by.kap.source, 'kase', 'KAP нет на AIX — взят с KASE'); eq(by.kap.price, 32, '16 000 ₸ → $32');
      eq(by.aapl.source, 'kase', 'нет ключа Twelve Data — сектор иностранных бумаг KASE'); eq(by.aapl.price, 190);
      eq(by.btc.price, 65000); eq(by.sber.price, 301); eq(by.hsbk, undefined);
      eq(Object.keys(r.failures).sort().join(), 'aix,global,kase', 'HSBK не найден нигде');
      eq(r.failures.global.code, 'no-key');
      eq(r.failures.kase.tickers.join(), 'HSBK', 'KAP и AAPL не считаются сбоем');
      eq(log.filter(function (l) { return /p\.example/.test(l.url); })[0].init.headers['X-Access-Token'], 'secret', 'токен прокси');
    });
  });

  test('Котировки: без прокси KASE недоступна, свежие цены не запрашиваются', function () {
    var fresh = { btc: { price: 1, fetchedAt: '2026-09-28T06:55:00Z' } };
    return QT.refreshQuotes({
      assets: [kcel, btc], latest: fresh, settings: {}, now: T('2026-09-28T07:00:00Z'),
      fetchJson: mockFetch([])
    }).then(function (r) {
      eq(r.requested, 1, 'BTC обновлён 5 минут назад');
      eq(r.updates.length, 0);
      eq(r.failures.kase.code, 'no-proxy');
    });
  });

  test('Курсы валют: Нацбанк через прокси, при сбое — запасной сервис', function () {
    var nbk = QT.refreshFx({ settings: { proxyUrl: 'https://p.example' }, currencies: ['USD', 'EUR'],
      fetchJson: mockFetch([[/p\.example\/fx/, { rates: [{ date: '2026-09-28', base: 'USD', quote: 'KZT', rate: 481.2 }, { date: '2026-09-28', base: 'CNY', quote: 'KZT', rate: 66 }] }]]) });
    var er = QT.refreshFx({ settings: { proxyUrl: 'https://p.example' }, currencies: ['USD'],
      fetchJson: mockFetch([[/p\.example/, new Error('502')], [/er-api/, { result: 'success', base_code: 'USD', rates: { USD: 1, KZT: 479 } }]]) });
    return Promise.all([nbk, er]).then(function (rs) {
      eq(rs[0].source, 'nbk'); eq(rs[0].rates.length, 1, 'только нужные валюты'); eq(rs[0].rates[0].rate, 481.2);
      eq(rs[1].source, 'er'); eq(rs[1].rates[0].rate, 479);
    });
  });

  /* ---------- PIN-код ---------- */

  test('PIN-код: формат, соль, проверка', function () {
    eq(C.validPin('1234'), true); eq(C.validPin('123456'), true);
    eq(C.validPin('123'), false, 'короткий'); eq(C.validPin('1234567'), false, 'длинный'); eq(C.validPin('12a4'), false, 'буквы');
    return Promise.all([C.makePin('2580'), C.makePin('2580'), C.hashPin('1234', 'salt')]).then(function (r) {
      eq(r[0].hash.length, 64, 'SHA-256 в hex'); eq(r[0].len, 4);
      eq(r[0].hash !== r[1].hash, true, 'одинаковый PIN с разной солью даёт разный хэш');
      // эталон: sha256("salt:1234")
      eq(r[2], '35c56314f89066056408d6d269daf9e69217b9953215f286eec86cec3076271a', 'совпадает с эталоном SHA-256');
      return Promise.all([C.checkPin('2580', r[0]), C.checkPin('2581', r[0]), C.checkPin('2580', null)]);
    }).then(function (ok) { eq(ok.join(), 'true,false,false'); });
  });

  /* ---------- вывод ---------- */

  var done = Promise.all(pending).then(function () {
    var failed = results.filter(function (r) { return !r.ok; });
    if (typeof module !== 'undefined' && module.exports) {
      results.forEach(function (r) { console.log((r.ok ? '✓ ' : '✗ ') + r.name + (r.ok ? '' : '\n    ' + r.error)); });
      console.log('\n' + (results.length - failed.length) + ' из ' + results.length + ' тестов пройдено');
      if (failed.length) process.exitCode = 1;
    }
    return results;
  });
  root.TEST_DONE = done;
})(typeof globalThis !== 'undefined' ? globalThis : this);
