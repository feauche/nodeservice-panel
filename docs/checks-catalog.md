# Каталог диагностических проверок ноды (research 2026-08-26)

Тесты, которые панель умеет запускать, а AI — выбирать уместные (см.
`PROMPT_CHECKS_SELECT` в `ai-prompts.md`). Пометки безопасности:
**[АВТО]** безопасно автоматически · **[ОСТОРОЖНО]** может кратко нарушить работу,
нужен авто-откат/лимит частоты · **[РУКИ]** только вручную.

> Принцип: для всего [ОСТОРОЖНО], что трогает firewall, — никогда не делать
> необратимое без заранее поднятого watchdog с гарантированным авто-возвратом
> (`systemd-run --on-active=180 ...`). Предпочитать точечные проверки глобальному
> отключению.

## 1. Сеть / доступность
- [АВТО] `ping -c 20 <ip>` (учесть: ICMP часто режется → ложный «недоступен»).
- [АВТО] **MTU/PMTUD**: `ping -M do -s 1472 <ip>` (уменьшать size) / `tracepath <ip>` — частая причина «то работает, то нет» (оверлейные сети режут MTU до ≤1450).
- [АВТО] `mtr -rw -c 100 --tcp -P 443 <ip>` — потери/latency по хопам для TCP:443.
- [АВТО] `ss -tlnp | grep <port>` — порт слушает локально.
- [АВТО] `nc -zv <ip> <port>` (UDP ненадёжно).
- [АВТО] **check-host.net API** — порт/ping из десятков стран (мир vs РФ):
  `GET check-host.net/check-tcp?host=<ip>:<port>&max_nodes=10` → `/check-result/<id>`.

## 2. Firewall / доступ
- [АВТО] `ufw status verbose` / `iptables -L -n -v --line-numbers` (правила и порядок).
- [АВТО] **Безопасная альтернатива `ufw disable`**: сравнить счётчики DROP-правила
  `iptables -L -n -v | grep -i drop` ДО и ПОСЛЕ теста снаружи (check-host.net) —
  вырос счётчик → это правило режет. Диагностическая ценность та же, сервер не открываем.
- [АВТО] `fail2ban-client status sshd` / `get sshd banip` — не забанен ли IP.
- [ОСТОРОЖНО] `fail2ban-client set <jail> unbanip <ip>` — точечный разбан.
- [АВТО] **Docker+UFW**: `iptables -L DOCKER-USER -n -v` (Docker обходит UFW для `-p` портов; фикс — правила в `DOCKER-USER`, ref `ufw-docker`).
- [ОСТОРОЖНО→требует watchdog] полный `ufw disable`: только с `( sleep 180 && ufw --force enable ) & disown` ДО disable. Без watchdog — [РУКИ]. Лучше `ufw allow from <test_ip> to any port <port>`.

## 3. Скорость / канал
- [ОСТОРОЖНО] `speedtest --accept-license -f json` (Ookla), `librespeed-cli --json`, `fast-cli` (Netflix). Не чаще раза в час.
- [ОСТОРОЖНО] `iperf3 -c <ip> -t 5 -P 4` — отделить «канал» от «Xray/шифрование»; `iperf3 -c iperf.he.net` с ноды — чистый аплинк.
- [ОСТОРОЖНО] bufferbloat: `flent rrul` или фоновый iperf3 + параллельный ping (рост RTT под нагрузкой).

## 4. Гео / репутация IP
- [АВТО] Сверка ≥3 баз: `ipinfo.io/<ip>/json`, `ip-api.com/json/<ip>`, `stat.ripe.net/data/geoloc/data.json?resource=<ip>`, db-ip.
- [АВТО] Antifraud-флаги (proxy/VPN/fraud): IPQualityScore, scamalytics — близко к тому, как IP оценивает Google-подобный антифрод.
- [АВТО] **«Как видит Google»**: `curl -sI --socks5 127.0.0.1:<port> https://www.gstatic.com/generate_204` (ждём 204), `…/gemini.google.com/` — редирект/капча/«не доступно в стране».
- [АВТО] Блэклисты: Spamhaus ZEN `dig +short <rev_ip>.zen.spamhaus.org`; **AbuseIPDB** `GET api.abuseipdb.com/api/v2/check?ipAddress=<ip>` (Key заголовок, 1000/день, `abuseConfidenceScore`); VirusTotal `/api/v3/ip_addresses/<ip>`.

## 5. Блокировки / DPI
- [АВТО] РКН: reestr.rublacklist.net; antifilter.download (списки IP/доменов для локального `grep`).
- [АВТО] check-host.net с нодами В РФ vs вне РФ — отличает глобальную недоступность от целевой блокировки в РФ.
- [АВТО, нечасто] OONI `ooniprobe run websites --input <url>` — тесты цензуры (DNS-тампер/TCP/HTTP).
- [ОСТОРОЖНО, вручную] Шейпинг/ТСПУ: сравнить RTT/throughput на 443 vs нестандартный порт в то же время; паттерн «работает N сек → обрыв» — признак ТСПУ.
- [АВТО] Доступ к сервисам через прокси ноды: curl через SOCKS до google/openai/telegram/vk/gosuslugi.

## 6. DNS
- [АВТО] `dig +short A <домен> @8.8.8.8 @1.1.1.1 @<локальный>` — совпадает ли с IP ноды.
- [АВТО] `dig +dnssec <домен>` / `delv` (флаг AD = DNSSEC ок); `nc -z -u <resolver> 53`.

## 7. TLS / сертификат
- [АВТО] `echo | openssl s_client -connect <host>:443 -servername <sni> -tls1_3 | openssl x509 -noout -dates -subject -issuer` (срок/SNI/эмитент); `-showcerts` (цепочка).
- [АВТО, минуты] `testssl.sh <host>:443`.
- **Reality**: `openssl s_client -connect <dest>:443 -servername <dest> -tls1_3` — dest ОБЯЗАН TLS1.3 + ALPN h2; сверить client serverName ∈ server serverNames, shortIds, ключи (надёжно — только реальным тестовым подключением, п.8). Ref: github.com/XTLS/REALITY.

## 8. Сервисы ноды (Xray / remnanode / MTProxy)
- [АВТО] `docker ps --filter name=remnanode`, `docker inspect --format='{{json .State.Health}}' remnanode`, `docker logs --tail 300 remnanode | grep -iE "error|panic|fatal|refused"`, `docker stats --no-stream remnanode`.
- [АВТО] `docker exec remnanode xray version`; `xray run -test -config <cfg>` — dry-run валидация БЕЗ рестарта.
- [АВТО] `xray api statsquery -server=127.0.0.1:10085 -pattern ""` (нужен StatsService) — трафик РЕАЛЬНО идёт; `grpcurl -plaintext 127.0.0.1:10085 list`.
- [АВТО] **End-to-end**: curl через тестовый SOCKS-инбаунд ноды до ifconfig.me — исходящий IP = IP ноды, весь стек работает.
- [АВТО] Панель Remnawave `GET /api/nodes` (свой ключ) — isConnected/uptime/версия (точный путь сверить с актуальной докой).

## 9. Ресурсы сервера
- [АВТО] `mpstat -P ALL 1 5` — **колонка `%steal`** (переподписка CPU у хостера, «шумные соседи»).
- [АВТО] `uptime`, `free -h`, `vmstat 1 5`, `df -h && df -i`, `iostat -xz 1 5` (await/%util диска).
- [АВТО] `conntrack -C` vs `nf_conntrack_max`; `/proc/sys/fs/file-nr` vs `file-max`, `/proc/<pid>/limits` (nofile) — причины массовых обрывов под нагрузкой.
- [АВТО] `grep aes /proc/cpuinfo` + `openssl speed -evp aes-128-gcm` (AES-NI и скорость шифрования); `sensors`/`dmesg | grep -i throttl` (тротлинг, для дедиков).

## 10. Безопасность / общее
- [АВТО] `nmap -Pn -sV -p22,80,443,<node_port> <public_ip>` — скан СВОЕГО IP (лучше со второй машины). [РУКИ] полный `-p-`. **Только свой IP.**
- [АВТО] `apt list --upgradable`; [ОСТОРОЖНО/РУКИ] реальный upgrade.
- [АВТО] `timedatectl status && chronyc tracking` — **NTP-синхронизация** (рассинхрон ломает TLS/Reality, маскируется под блокировку).
- [АВТО] `last -n 20` / `journalctl _COMM=sshd`; `ss -tulnp` (лишние порты).

---

## ТОП-15 (максимум диагностической ценности)
1. Контейнер жив + логи (`docker ps` + `docker logs | grep error`).
2. Порт ноды слушает (`ss -tlnp`).
3. **End-to-end через сам прокси** (curl через SOCKS, исходящий IP) — единственный, доказывающий «реально работает».
4. Xray API statsquery — трафик реально идёт.
5. check-host.net снаружи (мир + отдельно РФ) — локально/глобально/только РФ.
6. DNS A/AAAA на нескольких резолверах.
7. TLS/Reality dest: TLS1.3 + ALPN h2.
8. Firewall без отключения — счётчики DROP + `ufw` vs `DOCKER-USER`.
9. fail2ban — не забанен ли IP.
10. Ресурсы: `%steal` + load + RAM/swap + диск.
11. Conntrack + file descriptors.
12. NTP-синхронизация времени.
13. Блокировка в РФ (реестр / check-host РФ vs не-РФ).
14. IP-репутация (Spamhaus + AbuseIPDB).
15. MTU/PMTUD (`ping -M do`).

## Источники
- check-host.net · Xray API: https://xtls.github.io/en/config/api.html · XTLS/REALITY: https://github.com/XTLS/REALITY · AbuseIPDB: https://docs.abuseipdb.com/
- Точные API-пути Remnawave-панели и reestr.rublacklist.net сверить с актуальной докой перед автоматизацией.
</content>
