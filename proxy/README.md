# Прокси котировок

Небольшой Cloudflare Worker, через который приложение получает котировки **KASE** и **AIX**
и официальные курсы **Национального банка РК**. Браузер не может запросить эти сайты напрямую:
они не отдают CORS-заголовки. Прокси ничего не хранит и не пишет в журнал, получает только тикеры.

Бесплатного тарифа Cloudflare (100 000 запросов в день) хватает с большим запасом.

## Развёртывание за 5 шагов

1. Зарегистрируйтесь на [dash.cloudflare.com](https://dash.cloudflare.com) (бесплатно).
2. **Workers & Pages → Create → Create Worker**, назовите, например, `portfolio-proxy`, нажмите **Deploy**.
3. **Edit code**: удалите пример, вставьте содержимое [`worker.js`](worker.js), нажмите **Deploy**.
4. **Settings → Variables and Secrets** — добавьте:
   | Имя | Тип | Значение |
   |---|---|---|
   | `ACCESS_TOKEN` | Secret | любой длинный пароль — чтобы прокси не могли использовать посторонние |
   | `ALLOWED_ORIGIN` | Text | адрес приложения, например `https://yeakhmetov.github.io` |
   | `TN_API_KEY` | Secret | публичный ключ API Freedom (Tradernet) — для KASE и AIX |
   | `TN_SECRET` | Secret | секретный ключ API Freedom (Tradernet) |
   | `TN_API_URL` | Text | необязательно; по умолчанию `https://tradernet.com/api` |
5. В приложении: **Ещё → Котировки** — вставьте адрес воркера (`https://portfolio-proxy.<имя>.workers.dev`)
   и `ACCESS_TOKEN`, нажмите **Проверить источники**.

Курсы Нацбанка работают сразу после шага 3. Для KASE и AIX нужны ключи API брокера (шаг 4) —
как их получить и какие есть альтернативы, см. [docs/quotes-sources.md](../docs/quotes-sources.md).

## Проверка

```
curl -H "X-Access-Token: <ACCESS_TOKEN>" https://portfolio-proxy.<имя>.workers.dev/health
curl -H "X-Access-Token: <ACCESS_TOKEN>" "https://portfolio-proxy.<имя>.workers.dev/quotes?symbols=kase:KCEL,aix:KAP"
curl -H "X-Access-Token: <ACCESS_TOKEN>" https://portfolio-proxy.<имя>.workers.dev/fx
```

Тесты без сети: `node proxy/test.mjs`.
