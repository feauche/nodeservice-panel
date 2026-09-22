# Проверки, блокировки и шейпинг — референс (research 2026-08-26)

Справочник для будущего модуля «Проверки» (скорость, гео, блокировки РКН/ТСПУ,
доступ к сервисам, DDoS). Связан с инфра-биллингом (тумблер «проверять домен на
блокировку РКН») и AI-ассистентом (даёт факты «как есть»). Расписания —
настраиваемые, значения по умолчанию ниже AI считает справедливыми.

## 1. Скорость канала
- **iperf3** к своему контрольному серверу — самый честный замер (`iperf3 -c host --json`).
- **Ookla Speedtest CLI** (`speedtest --accept-license -f json`) — точный, но проверить EULA для платного сервиса.
- **speedtest-cli** (sivel, MIT) — открытый, без лицензионных ограничений; **librespeed-cli** — self-hosted.
- Не гонять полный тест с боевой ноды в пик — лучше с отдельной мониторинг-VM в том же ДЦ или в ночное окно; предварительно смотреть загрузку (`vnstat`, `ss`).

## 2. Гео-чек IP
- Базы: MaxMind GeoLite2 (локальная .mmdb), IP2Location, ipinfo.io (Lite API), ip-api.com (45 req/min), ipregistry.
- Один IP по-разному размечается, т.к. базы строятся на WHOIS/RIR + своя телеметрия и обновляются асинхронно (особенно облачные диапазоны).
- **Google геолокацию считает сам** — финский IP мог определяться как «Россия» и блокировать Gemini (RU/CN/IR/KP). Проверять прямо: `curl -s https://gemini.google.com/ | grep -i "not available"`, OpenAI — ошибка `unsupported_country_region_territory`. Визуально — через SOCKS-туннель на ноду открыть `adssettings.google.com`.

## 3. Блокировка РКН (ключевое)
- Официальные (eais/vigruzki/blocklist.rkn.gov.ru) — капча, публичного API нет → не основной канал.
- **Основной источник: reestr.rublacklist.net API v3** (Роскомсвобода, обновление ~раз в 3 ч):
  - `/api/v3/ips/` — заблокированные IP; `/api/v3/ct-domains/` — домены без записи в реестре;
  - **`/api/v3/dpi/`** — домены/ресурсы, режущиеся через DPI/ТСПУ (в офиц. реестре их НЕТ — самое ценное);
  - `/api/v3/record/{ID}/`, `/snapshot/`. API v2 устарел.
- Архив реестра: `github.com/zapret-info/z-i` (`dump.csv`, история коммитов — когда домен попал в реестр).
- Готовые списки для маршрутизации: `github.com/itdoginfo/allow-domains` (Russia inside/outside, форматы sing-box/xray/mikrotik).

## 4. Детект шейпинга/DPI/ТСПУ (ключевое)
Официального API нет — только прямое измерение + краудсорс.
- **OONI Probe CLI** — `web_connectivity`, тесты мессенджеров (telegram/…), `http_header_field_manipulation` (middlebox), `psiphon`/`tor`. Кастомный тест-лист под свой домен — через **OONI Run**.
- **RIPE Atlas** — ping/traceroute/TLS из точек внутри РФ по расписанию (перепроверить лимиты API).
- **Flent (rrul)** — bufferbloat: отличить шейпинг от перегрузки/потерь.
- **mtr** из разных RU-операторов (МТС/Билайн/МегаФон/Ростелеком) — ТСПУ развёрнуты неравномерно.
- Живые сигналы новых паттернов ТСПУ: форум **ntc.party**, GitHub-discussions **bol-van/zapret**.
- **Методика:** параллельно мерить (a) обычный HTTPS-443 к «безобидному» хосту и (b) сам VLESS+Reality к ноде из RU-точки; просадка только (b) при нормальном (a) → сигнатура протокольного шейпинга. Трекать тренд по времени (ТСПУ блокирует «с задержкой»).

## 5. Доступ к сервисам
- Универсально — **Prometheus Blackbox Exporter** (HTTP/TCP/DNS/ICMP-пробы, `probe_success`, `probe_http_status_code`).
- Классы: доступно (200/204 в норме) / деградация (latency ≫ базы) / недоступно (timeout/refused/страница-блок).
- Госуслуги/Сбер — только TCP+TLS-handshake (`openssl s_client`), не полная страница (анти-бот даёт ложные срабатывания); проверять редко.
- Google `generate_204` (ждём 204); OpenAI — `unsupported_country_region_territory` + status.openai.com; Telegram — HTTPS + TCP до ДЦ (канарейка ТСПУ).

## 6. DDoS vs просто недоступность
- Инструменты: `vnstat`, `iftop/nload`, `conntrack -S` + `nf_conntrack_count/max`, `ss -tan state syn-recv | wc -l`, `tcpdump`, IDS (Suricata/Zeek), **FastNetMon** (NetFlow/sFlow/PCAP, детект по pps/bps за 1-2 с, авто BGP-blackhole).
- **Признаки:** DDoS → всплеск inbound pps/bps, асимметрия in≫out, рост SYN-RECV/conntrack, сервер жив по IPMI, часто письмо от хостера о blackhole. Крах → тишина по всем протоколам (в т.ч. ICMP), IPMI недоступен, письма нет.

## 7. Расписания по умолчанию (ориентиры)
| Проверка | Частота |
|---|---|
| Uptime (ping/HTTP/TCP) | 30 с – 5 мин, непрерывно |
| Speedtest | 1 раз/сутки, 03:00–05:00 местного (или с мониторинг-VM) |
| Гео-IP | 1 раз/нед–мес + при смене IP или жалобе |
| Реестр РКН / DPI-фид Роскомсвободы | каждые 3–6 ч (реестр сам обновляется ~3 ч) |
| Активное зондирование ТСПУ из РФ (OONI/Atlas) | 1 раз/сутки–нед |
| Доступность сервисов (Google/OpenAI/TG/VK) | раз в неск. минут |
| Госуслуги/Сбер | раз в 5–15 мин |
| DDoS/аномалии | непрерывный поток (FastNetMon), не polling |

## Ключевые ссылки
- reestr.rublacklist.net API v3: https://reestr.rublacklist.net/ru/article/api/
- zapret-info/z-i: https://github.com/zapret-info/z-i · itdoginfo/allow-domains: https://github.com/itdoginfo/allow-domains
- OONI CLI: https://ooni.org/install/cli/ · Flent: https://flent.org · FastNetMon: https://github.com/pavel-odintsov/fastnetmon
- iperf3: https://software.es.net/iperf/invoking.html · check-host.net: https://check-host.net/
- Кейс Gemini/гео-РФ: https://discuss.ai.google.dev/t/ncorrect-ip-geolocation-finland-russia-causing-gemini-api-access-block/85335
