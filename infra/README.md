# infra — инфраструктура и установка

Docker Compose стек панели и установка «одной командой».

Сервисы (план): `panel`, `postgres`, `redis`, `victoriametrics`, `caddy`
(reverse-proxy с авто-HTTPS). Установочный скрипт генерирует `.env` с секретами
(`openssl rand`) и поднимает стек. Агент — отдельный артефакт, ставится на ноды.

Скелет: [`docker-compose.yml`](docker-compose.yml).
См. [`../docs/architecture.md`](../docs/architecture.md).

> Значения-плейсхолдеры. Реальные образы появятся на этапе реализации Фазы 1.
