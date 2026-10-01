/** Настоящий словарь терминов, присланный владельцем: проверяем, что из него берётся всё до последнего термина. */
export const GLOSSARY_TEXT = `Термины простыми словами
Здесь собраны все термины, которые встречаются в гайдах, коротко и без занудства. Не нужно учить наизусть: просто возвращайтесь сюда, если где-то встретили незнакомое слово. Термины сгруппированы по темам.

💡 Почти в каждой статье технические слова поясняются прямо в тексте при первом упоминании. Этот словарь нужен, чтобы всё было в одном месте.

Блокировки и как нас ловят

DPI (Deep Packet Inspection): «глубокий досмотр трафика». Система на стороне оператора связи, которая смотрит не только куда идёт пакет, но и как он выглядит, и по этим признакам вычисляет VPN. Главный противник.
ТСПУ: российское «железо» DPI, установленное у операторов (то самое, что «замедляет» и блокирует). На практике = DPI.
РКН: Роскомнадзор, ведомство, которое ведёт блокировки.
Рукопожатие (handshake): момент установки защищённого соединения: первые пакеты, которыми клиент и сервер «договариваются». По ним VPN проще всего опознать, поэтому маскируют именно их.
SNI (Server Name Indication): имя сайта, которое видно в самом начале TLS-соединения ещё до шифрования. DPI читает его, чтобы понять, куда вы идёте.
Отравленный / «грязный» IP: адрес сервера, уже попавший под блок. Лечится сменой IP или уходом за CDN.
Шифрование и маскировка

TLS: стандартное шифрование, на котором работает весь HTTPS (замочек в браузере). VPN прячется внутри обычного TLS, чтобы выглядеть как поход на сайт.
Reality: способ маскировки, при котором ваш VPN выдаёт себя за визит на чужой реальный популярный сайт (Google, Microsoft и т.п.). Не нужен свой домен и сертификат: со стороны выглядит как обычный HTTPS.
Self-steal (селфстил): тот же Reality, но «донор» это ваш собственный сайт-заглушка на сервере. Максимально незаметно: вы ничего чужого не задействуете. Самый стойкий вариант под жёсткий DPI.
Донор: чужой сайт, под TLS-рукопожатие которого маскируется Reality.
Fingerprint (отпечаток, fp): «почерк» TLS-клиента. Его подделывают под настоящий браузер (chrome, firefox), чтобы соединение не выделялось. Для РФ обычно ставят firefox.
UUID: длинный уникальный код-идентификатор пользователя или ключа (похож на xxxx-xxxx-...).
Протоколы и транспорты

Xray (Xray-core): движок, на котором работают ноды: он умеет VLESS, Reality, XHTTP и остальное.
VLESS: лёгкий современный протокол передачи данных, основа большинства нынешних VPN на Xray.
Транспорт: способ «упаковки» трафика. От него зависит, переживёт ли канал блокировку. Основные: raw/TCP, gRPC, XHTTP, QUIC.
raw / TCP: базовый транспорт по TCP (в xray 26 tcp переименовали в raw, это одно и то же).
Vision: добавка к VLESS-TCP, которая маскирует размеры пакетов. Под жёстким DPI её иногда душат.
gRPC: транспорт поверх HTTP/2 с мультиплексом (много потоков в одном соединении). В xray 26 помечен deprecated: работает, но на замену пришёл XHTTP.
XHTTP: современный транспорт, особенно хорош за CDN. Рекомендуемый выбор, когда нужен обход по IP.
Мультиплекс: несколько логических потоков внутри одного соединения (чтобы выглядело как обычный сайт с кучей запросов).
Hysteria2: протокол поверх QUIC/UDP. Отлично держится на плохих и мобильных сетях, когда TCP душат.
QUIC: быстрый транспорт поверх UDP (по сути «HTTP/3»).
Trojan: протокол, который маскируется под обычный HTTPS-сайт. Держат как резерв «другого вида».
Shadowsocks (SS-2022): старый прокси-протокол без TLS-маскировки. Под жёстким РФ-DPI заметен: только запасной вариант.
MTProto: прокси-протокол Telegram (для проксирования именно Telegram).
Инфраструктура

Панель: веб-центр управления сервисом (у нас это Remnawave / Rw): пользователи, подписки, ноды, статистика.
Нода: сервер, к которому реально подключаются клиенты. Панель это мозг, ноды это руки.
Инбаунд (inbound): «входная точка» на ноде: связка протокол + порт + настройки, куда стучится клиент.
Хост (host): запись в панели, описывающая один готовый конфиг, который получит клиент.
Порт 443: стандартный порт HTTPS. VPN сажают на него, чтобы прятаться среди обычного веб-трафика.
Роутинг (routing): правила «какой трафик куда»: например, российские сайты идут напрямую, а всё остальное через VPN. Экономит ресурс и ускоряет.
Selfsteal-страница / subpage: сайт-заглушка на ноде, который видит посторонний, если зайдёт по адресу. Часть маскировки.
Обход блокировок

CDN: сеть серверов-посредников (Cloudflare, Yandex и др.), которая прячет реальный IP вашего сервера. Блокировка «по адресу» после этого перестаёт работать.
CDN-фронтинг: подключение к вашему серверу через домен CDN, чтобы снаружи всё выглядело как обращение к Cloudflare, а не к вам.
Каскад: цепочка из нескольких нод: вход внутри РФ → выход за границей. Клиент видит быстрый локальный вход, а трафик уходит транзитом наружу.
Реле (relay): промежуточная нода в каскаде (через неё трафик идёт дальше).
WARP: сервис Cloudflare, который часто используют как «чистый» выход наружу (например, чтобы убрать рекламу или обойти гео-ограничения сайтов).
Ротация: регулярная смена IP, доноров, портов после волны блокировок.
Клиент и продажи

Подписка (subscription): ссылка, по которой клиентское приложение само забирает и обновляет конфиги. Дал ссылку → клиент подключился.
Автовыбор / балансер: механизм, который автоматически ставит клиента на самую быструю и живую ноду и переключает при обрыве.
Фейловер: автоматическое переключение на запасной конфиг, если основной лёг.
HWID: привязка к «железу» устройства (чтобы одну подписку не раздавали всем подряд).
Grace-период: короткая отсрочка после окончания оплаты, когда доступ ещё работает (чтобы человек успел продлить).
Панель: что с чем связано

Конфиг-профиль: целый конфиг ядра для ноды — входящие соединения, исходящие, правила маршрутизации. Панель сама раскатывает его на серверы.
Сквад внутренний (Internal Squad): набор инбаундов, который достаётся человеку. По сути тариф: какие каналы ему вообще доступны.
Сквад внешний (External Squad): настройки выдачи подписки — какой шаблон применить, как назвать хосты в списке, сколько устройств разрешить, какую страницу показать.
Шаблон подписки: заготовка конфига, который получает приложение. Именно в нём живут маршрутизация и автовыбор, а не в настройках ноды.
Пробы (health-check): маленькие проверочные запросы, по которым балансировщик решает, жив узел или нет. Отвечающий, но задушенный узел они не ловят.
leastPing и leastLoad: две стратегии выбора. Первая берёт самый быстрый по отклику узел, вторая — самый стабильный по разбросу отклика.
CDN, каскады и маршруты

Ориджин (источник): ваш сервер, с которого CDN забирает данные. Клиент его не видит.
Эдж: сервер сети CDN, ближайший к клиенту. К нему клиент и подключается.
Прогрев: 15–30 минут после настройки CDN, пока сертификат и настройки расходятся по всем эджам. В это время часть запросов ведёт себя странно, и это нормально.
Аплинк: то, что клиент отправляет наверх, в отличие от того, что скачивает. За некоторыми CDN его приходится передавать заголовками.
Буферизация: когда промежуточный сервер копит ответ целиком, прежде чем отдать дальше. Для сайтов полезно, для VPN смертельно — везде выключают.
Хоп: один сервер в цепочке. Обычный каскад — два хопа, тройной — три.
Fallback: правило «если запрос не похож на наш, отдай его вон туда». Так один порт обслуживает и VPN, и настоящий сайт.
PROXY protocol: приписка в начале соединения, которой посредник сообщает дальше настоящий адрес клиента. Без неё в логах виден только адрес посредника.
sendThrough: настройка, указывающая, с какого именно адреса сервера уходит исходящее соединение. Нужна, когда у машины несколько адресов и один из них надо беречь.
Адреса и сети

Подсеть: диапазон адресов, принадлежащий одному провайдеру. Блокируют обычно её целиком, а не один адрес.
Выделенный IP: адрес, который принадлежит только вашему серверу. Без него порты 80 и 443 вам не принадлежат, и ни панель, ни нода на них не поднимутся.
Белый IP: адрес, который у мобильных операторов ходит по «белым спискам» и не тратит трафик абонента. Подбирается долго, поэтому такие адреса берегут.
Целевая подсеть: диапазон, ради попадания в который перебирают адреса при подборе.
Ротация адресов: массовый перебор с удалением неподходящих — так набирают запас чистых адресов.
Сервер и его здоровье

BBR: режим управления скоростью отправки данных. Заметно помогает на длинных маршрутах до Европы, включается одной строкой.
OOM: ситуация, когда память кончилась и система убивает самый «жирный» процесс. Без лимита памяти жертвой может стать не VPN, а доступ к серверу.
Дескрипторы: счётчик одновременно открытых соединений и файлов. Упёрлись в лимит — появляется ошибка «too many open files», и сервис встаёт.
Сниффинг (распознавание протокола): когда клиент или сервер определяет, к какому домену идёт соединение. Без него правила по доменам не срабатывают, и трафик уходит не туда.
Гео-файлы: списки доменов и адресов по странам и сервисам. Правила вида geosite: и geoip: без этих файлов молча не работают.
Не нашли термин? Напишите в чат, добавим. А дальше загляните в Дорожную карту, она свяжет все гайды в один маршрут.
`;

/** Сколько терминов в тексте выше (по строкам «термин: объяснение»). */
export const GLOSSARY_TEXT_TERMS = 68;

/**
 * Строки словаря, которые сервер сам в «Пояснения» не берёт: в пояснении путь, «;» и дата, как у вывода команд.
 * Их термины (до двоеточия) — в том же порядке в `MACHINE_LIKE_TERMS`.
 */
export const MACHINE_LIKE_LINES = [
  'Конфиг Xray: файл /usr/local/etc/xray/config.json, в котором описаны входы и выходы ноды.',
  'Обновление ядра: выходит примерно раз в месяц; что поменялось, видно в журнале изменений.',
  'Снимок сервера: копия диска на 2026-09-20, из которой сервер можно поднять заново.',
];
export const MACHINE_LIKE_TERMS = ['Конфиг Xray', 'Обновление ядра', 'Снимок сервера'];

/** Вопрос с выводом lscpu (находка аудита: раньше 15 «терминов» и шаблонный ответ без модели). */
export const LSCPU_QUESTION = `Почему процессор слабый? Вот lscpu:
Architecture:             x86_64
  CPU op-mode(s):         32-bit, 64-bit
  Address sizes:          40 bits physical, 48 bits virtual
  Byte Order:             Little Endian
CPU(s):                   2
  On-line CPU(s) list:    0,1
Vendor ID:                GenuineIntel
  Model name:             Intel Xeon Processor (Skylake, IBRS)
    CPU family:           6
    Model:                85
    Thread(s) per core:   1
    Core(s) per socket:   1
    Socket(s):            2
    Stepping:             4
    BogoMIPS:             4199.99
    Flags:                fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat pse36 clflush mmx fxsr sse sse2 ss syscall nx pdpe1gb rdtscp lm constant_tsc rep_good nopl xtopology cpuid tsc_known_freq pni pclmulqdq ssse3 fma cx16 pcid sse4_1 sse4_2 x2apic movbe popcnt tsc_deadline_timer aes xsave avx f16c rdrand hypervisor lahf_lm abm 3dnowprefetch cpuid_fault invpcid_single pti ssbd ibrs ibpb stibp fsgsbase tsc_adjust bmi1 hle avx2 smep bmi2 erms invpcid rtm mpx avx512f avx512dq rdseed adx smap clflushopt clwb avx512cd avx512bw avx512vl xsaveopt xsavec xgetbv1 xsaves arat pku ospke md_clear
Virtualization features:
  Hypervisor vendor:      KVM
  Virtualization type:    full
Caches (sum of all):
  L1d:                    64 KiB (2 instances)
  L1i:                    64 KiB (2 instances)
  L2:                     8 MiB (2 instances)
  L3:                     32 MiB (2 instances)
NUMA:
  NUMA node(s):           1
  NUMA node0 CPU(s):      0,1
Vulnerabilities:
  Gather data sampling:   Unknown: Dependent on hypervisor status
  Itlb multihit:          KVM: Mitigation: VMX unsupported
  L1tf:                   Mitigation; PTE Inversion
  Mds:                    Mitigation; Clear CPU buffers; SMT Host state unknown
  Meltdown:               Mitigation; PTI
  Mmio stale data:        Vulnerable: Clear CPU buffers attempted, no microcode; SMT Host state unknown
  Retbleed:               Mitigation; IBRS
  Spec rstack overflow:   Not affected
  Spec store bypass:      Mitigation; Speculative Store Bypass disabled via prctl and seccomp
  Spectre v1:             Mitigation; usercopy/swapgs barriers and __user pointer sanitization
  Spectre v2:             Mitigation; IBRS, IBPB conditional, STIBP disabled, RSB filling, PBRSB-eIBRS Not affected
  Srbds:                  Not affected
  Tsx async abort:        Mitigation; Clear CPU buffers; SMT Host state unknown`;

/** Вывод docker inspect: ключи в кавычках, хэши, пути, даты. */
export const DOCKER_INSPECT = `docker inspect remnanode
[
    {
        "Id": "3f4e8a0c2b1d9e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f",
        "Created": "2026-09-20T08:14:03.512345678Z",
        "Path": "/usr/local/bin/docker-entrypoint.sh",
        "Args": [
            "node",
            "dist/src/main"
        ],
        "State": {
            "Status": "running",
            "Running": true,
            "Paused": false,
            "Restarting": false,
            "OOMKilled": false,
            "Dead": false,
            "Pid": 1234,
            "ExitCode": 0,
            "Error": "",
            "StartedAt": "2026-09-20T08:14:04.001234567Z",
            "FinishedAt": "0001-01-01T00:00:00Z"
        },
        "Image": "sha256:9b2c4d6e8f0a1b3c5d7e9f1a3b5c7d9e1f3a5b7c9d1e3f5a7b9c1d3e5f7a9b1c",
        "ResolvConfPath": "/var/lib/docker/containers/3f4e8a0c2b1d9e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f/resolv.conf",
        "HostnamePath": "/var/lib/docker/containers/3f4e8a0c2b1d9e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f/hostname",
        "HostsPath": "/var/lib/docker/containers/3f4e8a0c2b1d9e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f/hosts",
        "LogPath": "/var/lib/docker/containers/3f4e8a0c2b1d9e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f/3f4e8a0c2b1d9e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f-json.log",
        "Name": "/remnanode",
        "RestartCount": 0,
        "Driver": "overlay2",
        "Platform": "linux",
        "MountLabel": "",
        "ProcessLabel": "",
        "AppArmorProfile": "docker-default",
        "HostConfig": {
            "NetworkMode": "host",
            "RestartPolicy": {
                "Name": "always",
                "MaximumRetryCount": 0
            },
            "LogConfig": {
                "Type": "json-file",
                "Config": {
                    "max-size": "50m"
                }
            }
        },
        "Config": {
            "Hostname": "de-fra-01",
            "Image": "remnawave/node:latest",
            "WorkingDir": "/opt/app",
            "Entrypoint": [
                "/usr/local/bin/docker-entrypoint.sh"
            ]
        }
    }
]`;

/** Вывод docker info: «ключ: значение» на английском. */
export const DOCKER_INFO = `Client: Docker Engine - Community
 Version:    27.3.1
 Context:    default
 Debug Mode: false
 Plugins:
  buildx: Docker Buildx (Docker Inc.)
    Version:  v0.17.1
    Path:     /usr/libexec/docker/cli-plugins/docker-buildx
  compose: Docker Compose (Docker Inc.)
    Version:  v2.29.7
    Path:     /usr/libexec/docker/cli-plugins/docker-compose

Server:
 Containers: 3
  Running: 3
  Paused: 0
  Stopped: 0
 Images: 5
 Server Version: 27.3.1
 Storage Driver: overlay2
  Backing Filesystem: extfs
  Supports d_type: true
  Using metacopy: false
  Native Overlay Diff: true
  userxattr: false
 Logging Driver: json-file
 Cgroup Driver: systemd
 Cgroup Version: 2
 Plugins:
  Volume: local
  Network: bridge host ipvlan macvlan null overlay
  Log: awslogs fluentd gcplogs gelf journald json-file local splunk syslog
 Swarm: inactive
 Runtimes: io.containerd.runc.v2 runc
 Default Runtime: runc
 Init Binary: docker-init
 containerd version: 7f7fdf5fed64eb6a7caf99b3e12efcf9d60e311c
 runc version: v1.1.14-0-g2c9f560
 init version: de40ad0
 Security Options:
  apparmor
  seccomp
   Profile: builtin
  cgroupns
 Kernel Version: 5.15.0-122-generic
 Operating System: Ubuntu 22.04.5 LTS
 OSType: linux
 Architecture: x86_64
 CPUs: 2
 Total Memory: 1.918GiB
 Name: de-fra-01
 ID: 5b1c2d3e-4f5a-6b7c-8d9e-0f1a2b3c4d5e
 Docker Root Dir: /var/lib/docker
 Debug Mode: false
 Experimental: false
 Insecure Registries:
  127.0.0.0/8
 Live Restore Enabled: false`;

/** Статья «проблема: решение»: не словарь, её нужно сохранять статьёй. */
export const FAQ_TEXT = `Частые проблемы клиентов
Не подключается по мобильному интернету: переключите транспорт на XHTTP и включите мультиплекс, если оператор режет длинные соединения.
Подключается, но сайты не открываются: проверьте, что в подписке выбран живой сервер, и обновите подписку в приложении.
Медленно работает YouTube: включите в приложении «Автовыбор» и выберите ноду с наименьшим пингом.
Отваливается через пару минут: смените порт на 443 и проверьте, не включён ли у клиента режим экономии батареи.
Не работает на iPhone после обновления: удалите профиль и заново импортируйте подписку по ссылке из бота.
Пишет «истекла подписка»: продлите оплату в боте, доступ вернётся в течение минуты после оплаты.
Не открывается Telegram: обновите приложение и проверьте, что в маршрутизации Telegram идёт через VPN.
Высокий пинг в играх: выберите ближайшую ноду и отключите мультиплекс для игрового профиля.
Приложение пишет «нет интернета»: перезапустите приложение, а если не помогло — перезагрузите телефон.`;
