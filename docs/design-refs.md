# Дизайн-референсы — разбор и вердикты

Дата: 2026-08-29 · Статус: **внедрено в демо** (владелец: «сделай всё и посмотрим»), кроме: компактная лента инцидентов (частично через плотность) — см. requirements §2

Референсы, которые прислал владелец (`design/test.txt`, `design/test2.txt` — это только HTML-оболочки React-SPA, содержимого в них нет; разбирались сами сайты и их исходники):
1. **Shadcn Dashboard 2** — shadcnstore.com/…/dashboard-2 (открытый репозиторий silicondeck/shadcn-dashboard-landing-template)
2. **Dash by Motoko UI** — dash.motokoui.com/overview (платный шаблон $49, публичного кода нет)
3. **Тема Vercel** — 21st.dev/@serafimcloud/themes/vercel (токены совпадают с tweakcn `vercel.json`)

Наш утверждённый язык: синеватый графит (`#0c0e12 → #14171d → #191d25 → #1f2530`), акцент `#6ea8fe`, статусы ok/warn/crit, радиусы 16/11/8, Archivo / IBM Plex Sans / IBM Plex Mono.

---

## Shadcn Dashboard 2 (silicondeck) — Business Dashboard

**Вердикт.** Полезен как каталог механик и как учебник по «слоистости» dark-темы, но визуально это generic-SaaS: ахроматика, Inter, cursor-pointer на всём, финансовые KPI. Для NodeService брать только скелет и инженерные приёмы, не облик.

**Взять как есть**
- Механика сайдбара: SIDEBAR_WIDTH=16rem / SIDEBAR_WIDTH_ICON=3rem, transition-[width] 200ms — у нас 250px рейл, добавить схлопывание в 48px иконки с сохранением активного маркера (в панели мониторинга место по горизонтали нужно карте и терминалу).
- Command palette по ⌘K (SearchTrigger→CommandSearch) — для флота серверов это главный навигатор: «перейти к ноде», «перезапустить xray на X», «открыть SSH». У нас есть поиск в топбаре, превратить его в палитру.
- Слоистость dark: card заметно светлее background (0.205 vs 0.145) — принцип у нас уже есть (#0c0e12 → #14171d → #191d25 → #1f2530), закрепить как правило: одна ступень на уровень вложенности, не больше трёх.
- Container queries (@container/main, @[250px]/card) для KPI-тайлов и карточек серверов вместо viewport-брейкпоинтов — карточки в гриде 2/3/4 колонки перестанут ломаться при ресайзе рейла и открытии терминала.
- Chart CSS-переменные (--color-<series>) из chartConfig — единый способ красить спарклайны/графики в light/dark из тех же токенов, что и статусы.
- Структура KPI-карточки: CardDescription (подпись) → CardTitle (число tabular-nums) → CardAction (бейдж дельты) → CardFooter (контекст). Хорошая иерархия, забрать порядок и tabular-nums.

**Адаптировать**
- Badge дельты (TrendingUp + %) — у нас дельта должна быть не «рост продаж», а «изменение за 15 мин / за час» с семантикой: для CPU/latency рост = warn/crit, для uptime рост = ok. Направление окрашивать по смыслу метрики, не по знаку.
- Tabs внутри полноширинной карточки (Customer Insights) — подходит для модалки ноды (Overview / Traffic / Logs / Config), но табы у нас должны быть подчёркиванием, не «pill с bg-background + shadow», иначе спорит с нашими 16px карточками.
- Строки списка `p-3 rounded-lg border` (Recent Transactions) — под ленту инцидентов: аватар → иконка ноды с кольцом статуса, сумма → длительность/severity, DropdownMenu → действия (ack, открыть ноду, SSH).
- Донат с центральным Label (Revenue Breakdown) — как разбивка трафика по протоколам/странам в модалке ноды, но с нашими 4 семантическими цветами + teal, не с 5 случайными chart-*.
- Hover-строки таблиц hover:bg-muted/30 и transition-colors — взять принцип «hover = +1 ступень поверхности», а не отдельный цвет.

**Не брать**
- Ахроматическая палитра chroma=0 и Inter — убьёт наш графитово-синий характер, никакого выигрыша для мониторинга.
- cursor-pointer на всех Card/Badge/строках — лжёт про интерактивность; для перфекциониста это раздражитель. Курсор-указатель только там, где есть клик.
- Градиент from-primary/5 на KPI (в dark всё равно отключён) — декоративный шум без функции.
- 5 chart-* цветов в оранжево-фиолетовой гамме — конфликтуют с семантикой ok/warn/crit; графики в панели мониторинга должны говорить статусами.
- Пагинация Previous/Next под таблицами, Select периода + Export в каждой шапке карточки — «SaaS-обвес», в single-admin панели лишний. Период — один глобальный переключатель в топбаре.
- Кнопка UpgradeToPro, ThemeCustomizer с variant/side/collapsible — не про продукт.
- Захардкоженные inline-данные вместо JSON — как архитектурный паттерн не повторять.

---

## Dash by Motoko UI (dash.motokoui.com)

**Вердикт.** Красивый, но плохо верифицируемый и о другом: task/CRM-шаблон с workspace-переключателем, календарём и заказами. Забирать можно только настроение (Raycast/Arc: монохром + один точечный синий, мягкие тени) и пару микропаттернов. Ни одна структура страниц не переносится на флот серверов.

**Взять как есть**
- Принцип «monochrome + один акцент точечно»: #2a85ff только на primary-кнопках, активном пункте нава, фокусе, линиях графиков — у нас это уже #6ea8fe, просто ужесточить дисциплину: акцент не для декора, только для «здесь можно нажать / здесь курсор».
- Относительное время («about 1 hour ago», «23 hours ago») в лентах активности и на карточках нод (последний heartbeat, последний деплой) — с абсолютным временем в title.
- Статус-бейджи с ограниченным словарём (Active/Paused/Archived) — у нас: online / degraded / offline / maintenance, ровно четыре, один цвет на состояние, без синонимов.
- Workspace-switcher вверху сайдбара — в нашем случае: переключатель окружений/групп нод (prod / staging / регион) с бейджем сводного статуса группы. Полезно, если флот > 10 серверов.

**Адаптировать**
- Overview-виджет «Tasks Overview» с процентами по статусам — превратить в «Fleet health»: доля нод online/degraded/offline как один компактный stacked-bar, не donut.
- «Today's Agenda» → «Планы обслуживания / ротация ключей / истечение сертификатов» с временными слотами — реально полезный блок для VPN-флота (сертификаты, домены, лимиты трафика).
- «Recent Activity» с разнотипными событиями — у нас уже есть incident cards; забрать только компактную однострочную плотность и иконку типа события слева.
- Мягкие многослойные тени «depth/widget» (не подтверждены точно) — можно реализовать своё: 0 1px 0 rgba(255,255,255,.04) inset + 0 1px 2px rgba(0,0,0,.4) + 0 8px 24px -12px rgba(0,0,0,.5). Только для плавающих слоёв (модалка, терминал, попапы), не для карточек в гриде.

**Не брать**
- Manrope+Inter — не подтверждено, и Manrope слишком «геометрично-дружелюбный» для control room. Archivo держит характер лучше.
- Radius 0.75rem с шкалой до 2rem — у нас уже 16/11/8, это та же лига; менять незачем.
- Calendar page с видами Month/Week/Day, Orders/Customers таблицы, Clerk-auth, промо-баннер — не про single-admin панель.
- Полагаться на этот референс для dark-темы — публичных данных о dark нет, слепо копировать нельзя.
- Светлый монохромный рендер демо как «целевой вид» — наш продукт по умолчанию тёмный, light вторична.

---

## Vercel theme (21st.dev / tweakcn vercel.json) — Geist, чёрное/белое, radius 8px

**Вердикт.** Как ЦЕЛЬНАЯ тема — не брать. Чистый чёрный фон #000 + белый primary + один акцент-чёрный сделают панель мониторинга слепой: статусы ok/warn/crit на #000 неоновые, сотни мелких метрик на pure black утомляют, 8px радиус потребует переверстать все компоненты и убьёт «мягкий» control-room характер. Брать: дисциплину теней, letter-spacing на крупных цифрах, Geist Mono как кандидат для данных, «shadow-as-border» для плавающих слоёв.

**Взять как есть**
- Тени как система из компонентов (--shadow-color/opacity/blur/offset) с крошечными значениями: 0 1px 2px / .18 — у нас тени должны быть именно такими на карточках в гриде: почти нет.
- Техника shadow-as-border `0 0 0 1px rgba(255,255,255,.06)` для попапов/тостов/терминала поверх карточек — не даёт двойного бордера и «сходится» по углам лучше, чем border на 16px радиусе.
- Отрицательный letter-spacing на крупных цифрах KPI (-0.02…-0.03em при 28–36px) и tracking 0 на мелком тексте — чётко подтягивает числа, особенно в Archivo.
- Geist Mono как альтернатива IBM Plex Mono для данных (компактнее, ровнее нули/единицы, tabular по умолчанию) — попробовать в терминале и в колонках метрик. Только если владелец готов на одну замену шрифта; иначе оставить Plex Mono.
- Шкала серого в 10 ступеней (gray-100…1000) как идея: формализовать наши поверхности как surface-0…surface-4 + border-1/border-2, а не «три hex».
- Focus-ring: чёткое кольцо 2px offset 2px на клавиатурном фокусе — у нас с ⌘K и терминалом фокус важен.

**Адаптировать**
- Chart-палитра: у Vercel 2 хроматичных + 3 серых. Для нас правильная идея: базовая линия графика — серый/teal, а цвет появляется только при выходе за порог (warn/crit). Не 5 цветных серий.
- Радиус: не переходить на 8px глобально, но привести к системе: 16 (карточки/модалки) → 10 (внутренние панели, инпуты, кнопки) → 6 (бейджи, чипы, ячейки). 11px заменить на 10 — чётнее с шагом 4px.
- Ахроматичный primary (чёрная кнопка на белом) — в нашем dark можно сделать основной CTA не синей заливкой, а светлой (#e7ebf2 на #0c0e12) для 1–2 главных действий (Add server), а синий оставить для ссылок/активных состояний. Это даёт Vercel-строгость без потери идентичности.

**Не брать**
- --background: oklch(0 0 0) чистый чёрный — потеря синеватого графита, «дыры» в интерфейсе при OLED-smearing, статусные цвета вибрируют, sparklines на #000 читаются хуже. Не брать.
- --primary белый, ноль синего в UI — активный пункт нава, live-индикатор, ссылки и фокус станут неразличимы от текста. У флота нужен один узнаваемый акцент.
- Geist Sans для заголовков — превращает панель в «ещё один Vercel-клон», ломает уже утверждённый Archivo.
- radius 8px как единый — придётся трогать каждую карточку, ринг-гейджи в карточках серверов будут выглядеть чужими в острых углах.
- Sidebar oklch(0.18) светлее card oklch(0.14) — инверсия наших слоёв (у нас рейл темнее контента); не переносить.
- 21st.dev как источник токенов — токены не подтверждены, брать только tweakcn json.

---

## Предложение по теме

**Итог.** НЕ переходить на Vercel-тему. Оставить синеватый графит и семантические статусы — это идентичность и функция мониторинга. Принять «Vercel-дисциплину» как гибрид: строже тени (почти нулевые в гриде, слоистые только для плавающих слоёв), shadow-as-border для оверлеев, отрицательный tracking на KPI-числах, формализованная шкала поверхностей surface-0…4, акцент только на интерактиве, светлый primary-CTA для 1–2 главных действий. Радиус не менять на 8, но выровнять на 16/10/6. Шрифты не менять (Archivo/Plex Sans/Plex Mono); Geist Mono — опциональный A/B только для терминала и колонок цифр.

**Токены dark (предложение):** --bg-0:#0c0e12 (page) --bg-1:#111419 (rail/topbar) --surface-0:#14171d (card) --surface-1:#191d25 (nested panel, hover row) --surface-2:#1f2530 (popover/inputs/active) --surface-3:#262c38 (terminal chrome, modal header) --border-1:#262b34 --border-2:#323945 (hover/focus border) --border-hairline:rgba(255,255,255,.06) (shadow-as-border для оверлеев) --text-1:#e7ebf2 --text-2:#a7afbd --text-3:#6b7382 (labels, units) --accent:#6ea8fe --accent-soft:rgba(110,168,254,.14) --accent-ring:rgba(110,168,254,.45) --primary-cta:#e7ebf2 / --primary-cta-fg:#0c0e12 --teal:#56c7b8 --ok:#46cf8b --warn:#e6b552 --crit:#f0616d --ok-soft:rgba(70,207,139,.14) --warn-soft:rgba(230,181,82,.14) --crit-soft:rgba(240,97,109,.14) --chart-base:#7d8797 (нейтральная линия графика) --chart-accent:#6ea8fe --chart-teal:#56c7b8

**Токены light:** --bg-0:#f5f6f8 --bg-1:#fbfbfc (rail/topbar) --surface-0:#ffffff --surface-1:#f2f4f7 --surface-2:#e9ecf1 --surface-3:#dfe3ea --border-1:#e2e5eb --border-2:#c9ced8 --border-hairline:rgba(9,12,20,.08) --text-1:#111419 --text-2:#4b5361 --text-3:#7c8494 --accent:#2f7ae5 (темнее #6ea8fe ради контраста 4.5:1 на белом) --accent-soft:rgba(47,122,229,.10) --accent-ring:rgba(47,122,229,.40) --primary-cta:#111419 / --primary-cta-fg:#ffffff --teal:#1f9d8d --ok:#1f9e60 --warn:#b8860b --crit:#d2414d --ok-soft:rgba(31,158,96,.12) --warn-soft:rgba(184,134,11,.12) --crit-soft:rgba(210,65,77,.12) --chart-base:#8a93a3

**Шрифты:** Заголовки/KPI-числа: Archivo 600, tracking -0.02em при ≥24px, -0.03em при ≥32px, font-variant-numeric: tabular-nums. Текст: IBM Plex Sans 400/500, tracking 0. Данные/метрики/терминал: IBM Plex Mono 400 (или Geist Mono как A/B, только если владелец одобрит; не смешивать два моно). Мелкие подписи 11–12px: Plex Sans 500, uppercase, tracking +0.06em, цвет text-3. Никакого Inter/Manrope/Geist Sans.

**Радиусы:** --r-lg:16px (карточки, модалка, терминал-окно, тосты) --r-md:10px (внутренние панели, инпуты, кнопки, KPI-бейдж) --r-sm:6px (чипы, статусы, ячейки, ключи в терминале) --r-full:9999 (аватар, точки статуса, live-индикатор). Заменить текущие 11px→10px и 8px→6px для чипов; кнопки 8→10. Вложенный радиус = внешний − padding (16 − 6 = 10).

**Тени:** Карточки в гриде: без box-shadow, только border-1 + inset 0 1px 0 rgba(255,255,255,.03) (тонкий верхний блик — даёт «объём» без тени). Hover карточки серверов: border-2 + translateY(-1px), тень не добавлять. Плавающие слои (popover, dropdown, тост): 0 0 0 1px var(--border-hairline), 0 4px 12px -4px rgba(0,0,0,.5). Модалка ноды / терминал: 0 0 0 1px var(--border-hairline), 0 1px 2px rgba(0,0,0,.4), 0 24px 48px -16px rgba(0,0,0,.6). Light: те же слои с rgba(9,12,20,.12/.18). Никаких цветных glow вокруг статусов — цветной свет только у live-индикатора (pulse) и точки crit.

**Риски**
- Потеря идентичности при переходе на #000/белый primary: панель станет неотличима от сотни Vercel-клонов, а владелец уже утвердил синеватый графит — поэтому Vercel берём только как дисциплину, не как палитру.
- Статусы на чистом чёрном: #46cf8b/#e6b552/#f0616d на #000 выглядят неоново и вибрируют, особенно точки 8px; на #0c0e12 они спокойнее. При любом затемнении фона держать soft-варианты (14% alpha) для заливок бейджей.
- Читаемость множества мелких метрик на pure black — контраст 21:1 при 11–12px даёт halation; наш #e7ebf2 на #14171d (≈14:1) оптимален. Не повышать контраст «до упора».
- Смена радиуса на 8px глобально трогает каждый компонент (ринг-гейджи, тайлы, модалка, терминал, тосты) и требует полной ревизии — цена L при нулевой пользе; выравнивание 11→10 и 8→6 — цена S.
- Светлый primary-CTA в dark может спорить с белыми чипами статуса «online» в топбаре — ограничить его 1–2 кнопками (Add server, Confirm в деструктивных диалогах — там crit).
- Light-акцент #2f7ae5 отличается от dark #6ea8fe — это осознанно (контраст), но нужно проверить, что sparklines и активный пункт нава используют токен, а не hex.
- Замена Plex Mono на Geist Mono даст чуть другую ширину символов — колонки таблиц и терминал придётся перепроверять; делать только как отдельный эксперимент.
- Формализация surface-0…3 потребует пройти по всем компонентам и убрать «случайные» hex (#1f2530 vs #1e2430 и т.п.) — обязательный, но нудный шаг перед любыми визуальными правками.

---

## Приоритетный список правок демо

| Правка | Зачем | Объём | Эффект |
|---|---|---|---|
| Аудит и формализация токенов: surface-0…3, border-1/2/hairline, text-1/2/3, *-soft — заменить все inline hex на переменные, привести радиусы к 16/10/6. | Без этого любая «полировка» будет разъезжаться по компонентам; это фундамент для всех пунктов ниже и единственный способ держать симметрию, которую требует владелец. | M | high |
| Тени: убрать box-shadow с карточек в гриде (border + inset-блик), ввести 2 уровня слоистых теней только для popover/toast и modal/terminal с shadow-as-border 1px. | Сейчас и в референсах тени либо везде, либо нигде; правильная иерархия — тень = «парит над контентом». Даёт Vercel/Raycast-строгость без смены палитры. НЕ делать цветные glow. | S | high |
| Типографика KPI: Archivo 600, 32px, tracking -0.03em, tabular-nums; единица измерения отдельным span 13px text-3; дельта — чип 11px с семантическим цветом по смыслу метрики, не по знаку. | Числа — главный контент панели мониторинга; сейчас они «как текст». Цветная дельта по знаку (как в shadcn) для CPU/latency вводит в заблуждение. | S | high |
| Command palette ⌘K вместо строки поиска в топбаре: ноды, действия (restart, SSH, rotate keys), страницы, недавние инциденты; группы и клавиатурные подсказки. | Single-admin с флотом серверов живёт на клавиатуре; это самый ценный функциональный заём из всех трёх референсов. | M | high |
| Сайдбар: icon-collapse 250→56px с анимацией width 200ms ease-out, тултипы на иконках, состояние в localStorage; активный пункт — accent-soft заливка + 2px левая полоска accent. | Карта и терминал требуют ширины; offcanvas (дефолт shadcn) не подходит — навигация должна оставаться видимой. | M | high |
| Hover-состояния как единая система: карточки серверов — border-2 + translateY(-1px) 150ms; строки — surface-1; кнопки-иконки — surface-2. Убрать cursor-pointer с некликабельных элементов. | Референсы учат «hover = следующая ступень поверхности». Владелец-перфекционист сразу замечает ложные курсоры и разные тайминги. | S | medium |
| Плотность: ввести переключатель comfortable/compact (padding карточек 20/14px, строки 44/34px, шрифт 14/13px), дефолт comfortable; хранить в настройках. | При росте флота до 20+ нод грид карточек с ринг-гейджами перестаёт помещаться; compact спасает без второго дизайна. | M | medium |
| Графики/спарклайны: базовая линия chart-base (серая) с заливкой 8%, цвет появляется только при пересечении порога (warn/crit) — пороговая линия пунктиром strokeDasharray 3 3; оси без axisLine/tickLine. | 5 радужных серий из shadcn/Vercel не имеют смысла в мониторинге; цвет должен означать «проблема». Даёт спокойный, «дорогой» вид. | M | medium |
| Лента инцидентов/активности: однострочные компактные элементы (иконка типа + текст + relative time + severity-чип), абсолютное время в title, действия в DropdownMenu. | Микропаттерн из Dash/Recent Transactions, но под флот. Уменьшает высоту ленты в 2 раза без потери информации. | S | medium |
| Primary CTA светлый (text-1 на bg-0) для Add server / главного действия модалки; синий — только ссылки, активные состояния, фокус, live-индикатор. | Дисциплина акцента из Vercel/Dash: синий перестаёт быть «декором» и начинает означать интерактив. Ограничить 1–2 кнопками. | S | medium |
| Focus-ring 2px accent-ring с offset 2px на всех интерактивах, видимый только на :focus-visible. | С ⌘K и терминалом клавиатурная навигация станет основной; сейчас фокус, вероятно, браузерный. | S | medium |
| Fleet health полоса в топбаре/над KPI: stacked-bar online/degraded/offline с числами, вместо donut. | Заём идеи Tasks Overview из Dash; stacked-bar читается за 0.3 с и не ест место. | S | medium |
| Блок «Обслуживание»: сертификаты/домены/лимиты трафика с датами истечения и relative time (адаптация Today's Agenda). | Единственный действительно новый функциональный виджет, релевантный VPN-флоту; предупреждает инциденты до их появления. | M | medium |
| Контейнерные запросы (@container) для KPI-тайлов и карточек серверов вместо viewport-брейкпоинтов. | При схлопывании сайдбара и открытии терминала гриды будут перестраиваться корректно — «ничего не вылезает». | S | low |
| НЕ делать: чёрный #000 фон, Geist Sans/Inter вместо Archivo, radius 8 глобально, градиентные шапки карточек, цветные glow вокруг статусов, Export/период в каждой шапке карточки, пагинацию под короткими списками, ThemeCustomizer с variant/side, cursor-pointer на всём. | Каждое из этого либо ломает утверждённую идентичность, либо добавляет SaaS-шум, либо стоит L при нулевой пользе для панели мониторинга. | S | high |

---

## Факты о референсах (с уверенностью)

### Shadcn Dashboard & Landing Template — Dashboard 2 (Business Dashboard) — уверенность: high

Открытый (бесплатный) шаблон админ-дашборда «Shadcn Dashboard & Landing Template» от ShadcnStore/silicondeck (репозиторий github.com/silicondeck/shadcn-dashboard-landing-template). Есть версии на Vite+React и Next.js 15, обе на shadcn/ui v3 + Tailwind CSS v4. Страница dashboard-2 — второй вариант дашборда, позиционируемый как «Business Dashboard / analytics dashboard» (в отличие от dashboard-1 — overview). Живёт в nextjs-version/src/app/(dashboard)/dashboard-2/page.tsx, набран из 7 отдельных клиентских React-компонентов.

- **accent:** Нейтральная (ахроматическая) OKLCH-палитра, chroma≈0 для базовых цветов. --primary (light): oklch(0.205 0 0) — почти чёрный; --primary-foreground: oklch(0.985 0 0). --accent (light): oklch(0.97 0 0) / accent-foreground oklch(0.205 0 0). Акценты на дашборде реализованы через прозрачность primary (bg-primary/10 text-primary — кружок-рейтинг в Top Products; from-primary/5 to-card — градиент карточек метрик) и через utility-цвета Tailwind (text-green-600/text-red-600/text-blue-600/text-orange-600 для роста/падения в таблицах CustomerInsights, fill-yellow-400 для звёзд рейтинга). Цвета графиков light: --chart-1: oklch(0.646 0.222 41.116); --chart-2: oklch(0.6 0.118 184.704); --chart-3: oklch(0.398 0.07 227.392); --chart-4: oklch(0.828 0.189 84.429); --chart-5: oklch(0.769 0.188 70.08). Dark: --chart-1: oklch(0.488 0.243 264.376); --chart-2: oklch(0.696 0.17 162.48); --chart-3: oklch(0.769 0.188 70.08); --chart-4: oklch(0.627 0.265 303.9); --chart-5: oklch(0.645 0.246 16.439).
- **border:** Light: --border: oklch(0.922 0 0); --input: oklch(0.922 0 0); --ring: oklch(0.708 0 0). Dark: --border: oklch(1 0 0 / 10%) (полупрозрачный белый); --input: oklch(1 0 0 / 15%); --ring: oklch(0.556 0 0). Отдельные sidebar-токены: --sidebar-border: oklch(0.922 0 0) light / oklch(1 0 0 / 10%) dark. Карточки и списки используют класс border (1px solid var(--border)), цветные бордеры почти не встречаются (кроме border-green-200 у бейджа роста в Top Products).
- **dark_bg:** --background: oklch(0.145 0 0) — тёмно-серый, не чистый чёрный. --foreground: oklch(0.985 0 0). --muted/--secondary/--accent в dark: oklch(0.269 0 0); --muted-foreground: oklch(0.708 0 0). --sidebar: oklch(0.205 0 0) — сайдбар светлее фона страницы.
- **dark_card:** --card: oklch(0.205 0 0); --card-foreground: oklch(0.985 0 0); --popover тот же oklch(0.205 0 0). В dark-теме card заметно светлее background (0.205 vs 0.145) — слоистость surface/elevated-surface; в light card = background = oklch(1 0 0), разделение только бордером/тенью.
- **fonts:** Единственный шрифт — Inter, подключается через next/font/google в src/lib/fonts.ts, пробрасывается CSS-переменной: globals.css `@theme inline { --font-sans: var(--font-inter); }`. В root layout.tsx: `<html className={`${inter.variable} antialiased`}>`, `<body className={inter.className}>`.
- **radius:** --radius: 0.625rem (базовый, ~10px). @theme inline: --radius-sm: calc(var(--radius) - 4px) [≈0.225rem]; --radius-md: calc(var(--radius) - 2px) [≈0.425rem]; --radius-lg: var(--radius) [0.625rem]; --radius-xl: calc(var(--radius) + 4px) [≈1.025rem]. Card использует rounded-xl, Button/Select/Input — rounded-md, Badge/Progress/аватары — rounded-full.
- **shadows:** Минималистичные тени shadcn: базовая Card = `shadow-sm`; кнопки (кроме ghost/link) = `shadow-xs`; карточки метрик дополнительно получают shadow-xs через `*:data-[slot=card]:shadow-xs`. Крупных/цветных теней и glow нет — объём строится на border + едва заметной тени + (в dark) разнице яркости card/background.

Заметки:
- Графики построены на Recharts, обёрнутом в фирменную shadcn/ui обёртку components/ui/chart.tsx (ChartContainer/ChartTooltip/ChartTooltipContent/ChartStyle) — она транслирует chartConfig (label+color) в CSS-переменные вида --color-sales, --color-target, которые используются прямо в SVG (stroke/fill) для авто-поддержки светлой/тёмной темы.
- Типы графиков на dashboard-2: AreaChart (Sales Performance, две area с градиентом), PieChart/donut с кастомным двойным Sector-highlight (Revenue Breakdown), BarChart с 3 сериями (Customer Growth Trends). Таблиц — 2 (Demographics, Regions) внутри Tabs. Календарей на dashboard-2 нет.
- Почти на всех элементах (Card, Badge, содержимое строк таблиц, TabsTrigger и т.д.) явно проставлен класс cursor-pointer — стилистическая особенность шаблона, не всегда отражающая реальную интерактивность (например, disabled-кнопки пагинации тоже стилизованы под курсор-указатель по умолчанию браузера, а не кастомно).
- Микро-анимации: transition-all на кнопках (base class buttonVariants), transition-colors на строках таблиц (hover:bg-muted/30) и на пунктах списка Revenue Breakdown (hover:bg-muted/50), TabsTrigger — transition-all при смене data-[state=active] (активная вкладка получает bg-background + shadow-sm). Анимация сворачивания сайдбара — duration-200 ease-linear.
- Карточки метрик получают лёгкий вертикальный градиент: `*:data-[slot=card]:from-primary/5 *:data-[slot=card]:to-card *:data-[slot=card]:bg-gradient-to-t`, при этом в dark принудительно `dark:*:data-[slot=card]:bg-card` — градиент в тёмной теме отключается, остаётся сплошной card-цвет.
- Палитра темы полностью ахроматична (chroma=0) у neutral-токенов background/foreground/card/border/muted/accent/primary; единственные хроматичные значения — 5 chart-* переменных и --destructive (oklch(0.577 0.245 27.325) light / oklch(0.704 0.191 22.216) dark).
- buttonVariants (src/components/ui/button.tsx) — база: inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 ... outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]; default: bg-primary text-primary-foreground shadow-xs hover:bg-primary/90; outline: border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:bg-input/30; ghost: hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50.
- Проект — монорепозиторий с двумя параллельными реализациями (vite-version/ и nextjs-version/); исследование велось по nextjs-version, но по описанию README структура и dashboard-2 идентичны в vite-version.

Источники:
- https://github.com/silicondeck/shadcn-dashboard-landing-template
- https://raw.githubusercontent.com/silicondeck/shadcn-dashboard-landing-template/main/nextjs-version/src/app/(dashboard)/dashboard-2/page.tsx
- https://raw.githubusercontent.com/silicondeck/shadcn-dashboard-landing-template/main/nextjs-version/src/app/(dashboard)/dashboard-2/components/metrics-overview.tsx
- https://raw.githubusercontent.com/silicondeck/shadcn-dashboard-landing-template/main/nextjs-version/src/app/(dashboard)/dashboard-2/components/sales-chart.tsx
- https://raw.githubusercontent.com/silicondeck/shadcn-dashboard-landing-template/main/nextjs-version/src/app/(dashboard)/dashboard-2/components/revenue-breakdown.tsx
- https://raw.githubusercontent.com/silicondeck/shadcn-dashboard-landing-template/main/nextjs-version/src/app/(dashboard)/dashboard-2/components/recent-transactions.tsx
- https://raw.githubusercontent.com/silicondeck/shadcn-dashboard-landing-template/main/nextjs-version/src/app/(dashboard)/dashboard-2/components/top-products.tsx
- https://raw.githubusercontent.com/silicondeck/shadcn-dashboard-landing-template/main/nextjs-version/src/app/(dashboard)/dashboard-2/components/customer-insights.tsx
- https://raw.githubusercontent.com/silicondeck/shadcn-dashboard-landing-template/main/nextjs-version/src/app/(dashboard)/dashboard-2/components/quick-actions.tsx
- https://raw.githubusercontent.com/silicondeck/shadcn-dashboard-landing-template/main/nextjs-version/src/app/(dashboard)/dashboard-2/components/dashboard-header.tsx
- https://raw.githubusercontent.com/silicondeck/shadcn-dashboard-landing-template/main/nextjs-version/src/app/(dashboard)/dashboard-2/data/dashboard-data.json
- https://raw.githubusercontent.com/silicondeck/shadcn-dashboard-landing-template/main/nextjs-version/src/app/(dashboard)/layout.tsx
- https://raw.githubusercontent.com/silicondeck/shadcn-dashboard-landing-template/main/nextjs-version/src/app/globals.css
- https://raw.githubusercontent.com/silicondeck/shadcn-dashboard-landing-template/main/nextjs-version/src/app/layout.tsx
- https://raw.githubusercontent.com/silicondeck/shadcn-dashboard-landing-template/main/nextjs-version/src/components/app-sidebar.tsx
- https://raw.githubusercontent.com/silicondeck/shadcn-dashboard-landing-template/main/nextjs-version/src/components/site-header.tsx
- https://raw.githubusercontent.com/silicondeck/shadcn-dashboard-landing-template/main/nextjs-version/src/components/ui/sidebar.tsx
- https://raw.githubusercontent.com/silicondeck/shadcn-dashboard-landing-template/main/nextjs-version/src/components/ui/card.tsx
- https://raw.githubusercontent.com/silicondeck/shadcn-dashboard-landing-template/main/nextjs-version/src/components/ui/button.tsx
- https://raw.githubusercontent.com/silicondeck/shadcn-dashboard-landing-template/main/nextjs-version/src/contexts/sidebar-context.tsx
- https://shadcnstore.com/templates/dashboard/shadcn-dashboard-landing-template/dashboard-2

### Dash by Motoko UI (dash.motokoui.com) — платный шаблон админ-дашборда — уверенность: medium

Dash — это не отдельный SaaS-продукт, а платный шаблон/стартер ($49) для админ-панелей от инди-разработчика senommu под брендом Motoko UI. Лендинг сам себя описывает так: «a minimal admin dashboard by Motoko UI — workspaces, customers, orders, and analytics in a polished, monochrome template built to ship fast», tagline — «Plan. Build. Ship.». Стек: React 19, Vite, TypeScript, TanStack Router/Query, shadcn/ui, Tailwind CSS v4, Clerk (авторизация). Демо на dash.motokoui.com/overview доступно публично без логина; исходники передаются только покупателям через Polar.sh — открытого GitHub-репозитория именно для Dash не найдено.

- **fonts:** В вопросе указана пара Manrope (заголовки) + Inter (текст) — публично подтвердить это напрямую не удалось (инструменты не выполняют JS и не читают скомпилированный CSS SPA). Есть контраргумент: в открытом репозитории ядра Motoko UI (motoko-ui/motokoui, apps/www/styles/globals.css) фактически используются Geist и Geist Mono, а не Manrope/Inter — то есть у Dash, вероятно, отдельная, кастомная тема шрифтов, отличная от лендинга-документации motokoui.com. Manrope+Inter — правдоподобная премиальная пара для отдельного платного шаблона, но не подтверждена публичным источником.
- **radius:** --radius: .75rem — подтверждено косвенно: в открытом globals.css Motoko UI базовый radius действительно равен 0.75rem, с производной шкалой вариантов от 0.5rem до 2rem (обозначения вроде lg…4xl). Прямого файла CSS именно Dash не найдено, но т.к. Dash описан как построенный на «custom design system» Motoko UI, значение выглядит достоверным.
- **accent:** #2a85ff — синий primary подтверждён напрямую в открытом коде: github.com/motoko-ui/motokoui, apps/www/styles/globals.css содержит ровно этот акцентный синий #2a85ff (плюс #00a656 зелёный, #ff381c красный, #7f5fff фиолетовый, #ff9d34 оранжевый как доп. семантические цвета). Сам лендинг Dash называет шаблон «monochrome» — то есть базовая палитра серая/нейтральная, а #2a85ff используется точечно (primary-кнопки, ссылки, активные состояния, вероятно линии графиков).
- **border:** Отдельного значения --border не подтверждено; в открытом CSS упоминается «surface hierarchy» — набор shade-переменных поверхностей от #141414 (тёмный) до #fdfdfd (почти белый), что по духу соответствует описанной в задаче шкале shade-01…shade-10 (10 градаций серого).
- **dark_bg:** Публичных данных о тёмной теме именно Dash не найдено (доступный рендер демо — светлый, монохромный). В экосистеме Motoko UI есть отдельный компонент Theme Switcher и тёмная тема (в основном сайте фон в dark ≈ oklch(0.17 0 0)), что делает наличие dark-режима в Dash вероятным, но не подтверждённым.
- **dark_card:** Не найдено публичных данных именно по карточкам в тёмной теме Dash.
- **shadows:** Многослойные тени «depth»/«widget», указанные в вопросе, публично не подтверждены — WebFetch и рендер через jina.ai reader отдают только текстовое содержимое DOM без CSS/box-shadow значений. Косвенно согласуется с общим визуальным языком Motoko UI (карточки, кнопки вроде Rainbow Button, компонент Notch и т.п. построены на мягких многослойных тенях и градиентах по описаниям в доках), но точных значений shadow-токенов получить не удалось.
- **other:** Реально наблюдаемые в демо детали: поиск по ⌘K, статус-бейджи (Active/Paused/Archived для workspaces; Lead/Active/Trial/Churned для customers; Paid/Unpaid/Payment Failed + Pending/Processing/Shipped для orders), аватары-инициалы владельцев записей (JK, AM, SL, RC), относительные метки времени («about 1 hour ago», «23 hours ago», «30 days ago»), промо-баннer с кодом скидки «21ST» на самом демо.

Заметки:
- Dash — платный шаблон ($49), а не бесплатный SaaS-сервис; покупка через Polar.sh checkout-ссылку, привязанную к странице motokoui.com/templates (источник: WebFetch motokoui.com/templates).
- Motoko UI продаёт три продукта: Dash ($49, админ-дашборд), Alpha ($59, лендинг для SaaS на Next.js 15/React 19/Tailwind v4/shadcn/Motion), Base Motoko ($129, Next.js-стартер с auth/billing/db/email/storage/analytics) — источник: motokoui.com/templates.
- Автор — senommu (профиль GitHub указывает Вьетнам, X-аккаунт @senommu); открытая часть экосистемы — только сама библиотека компонентов motoko-ui/motokoui (MIT-лицензия, ~6 звёзд на GitHub на момент проверки), отдельного публичного репозитория для Dash не существует.
- Бренд-философия из README: «Details make perfection, and perfection is not a detail» — вдохновение явно называется: Raycast, Revolut, Arc Browser; модель распространения кода как у shadcn/ui (copy-paste компонентов, а не npm-установка) — публичного npm-пакета 'motokoui' не найдено (npmjs.com/package/motokoui вернул 403).
- Официального changelog у Motoko UI нет — motokoui.com/changelog отдаёт 404.
- Публичных обзоров, статей, постов на Product Hunt/Reddit/Indie Hackers/X о Dash или Motoko UI на момент проверки (29 августа 2026) не найдено — проект слабо индексируется поисковиками, судя по всему очень нишевый/малоизвестный.
- Публичного Figma-файла или отдельной страницы UI-kit для Dash не обнаружено.
- Прямой WebFetch по URL dash.motokoui.com/overview и motokoui.com действительно отдаёт почти пустой контент (SPA рендерится на клиенте) — обход через прокси-рендерер r.jina.ai (headless-рендеринг) позволил получить реальный текстовый DOM демо-дашборда и подтвердить контент страниц, но не CSS/JS (поэтому точные значения shadow/gradient/mask-токенов остаются неподтверждёнными).

Источники:
- https://dash.motokoui.com/overview
- https://dash.motokoui.com/customers
- https://dash.motokoui.com/orders
- https://dash.motokoui.com/workspaces
- https://dash.motokoui.com/calendar
- https://dash.motokoui.com/ (лендинг 'Plan. Build. Ship.')
- https://motokoui.com
- https://motokoui.com/templates
- https://motokoui.com/docs
- https://motokoui.com/docs/backgrounds
- https://motokoui.com/docs/components/notch
- https://motokoui.com/changelog (404)
- https://github.com/motoko-ui/motokoui
- https://raw.githubusercontent.com/motoko-ui/motokoui/main/apps/www/styles/globals.css
- https://raw.githubusercontent.com/motoko-ui/motokoui/main/README.md
- https://github.com/senommu
- https://github.com/senommu/ui
- https://www.npmjs.com/package/motokoui (403)
- https://buy.polar.sh/polar_cl_OyNiw21j2IBUmgFijGmvgOKYKekpIB55VnSYf2uwEsu (checkout Dash, редиректит на polar.sh/404)

### Vercel (тема shadcn/ui на 21st.dev, автор serafimcloud) — сопоставление с пресетом "vercel" из tweakcn — уверенность: medium

Тема "Vercel" на 21st.dev (@serafimcloud/themes/vercel) — это готовая палитра CSS-переменных для shadcn/ui в стиле бренда Vercel/Geist: монохромная (чёрный/белый/серый) палитра в цветовом пространстве OKLCH, шрифт Geist, малый радиус скругления и еле заметные тени-обводки. 21st.dev — это client-rendered Next.js-приложение (App Router), и точные значения токенов темы подгружаются асинхронным запросом после гидратации — в статическом HTML их нет (проверено: в закэшированном HTML страницы /community/themes/[themeId] нет ни одного вхождения "oklch("). Поэтому прямое подтверждение "байт в байт" с 21st.dev получить не удалось; но публичный CDN-эндпоинт shadcn-реестра tweakcn отдаёт файл темы "vercel" (https://tweakcn.com/r/themes/vercel.json) с полным, дословно совпадающим по духу и структуре набором токенов (Geist, чёрный/белый, OKLCH, radius 0.5rem) — это и есть тот самый пресет tweakcn, который упоминается в задаче как вероятный первоисточник. Ниже приведены его точные значения (light/dark), плюс независимое описание фирменного языка Vercel/Geist."

- **accent:** LIGHT: --primary: oklch(0 0 0) [чёрный, текст на нём --primary-foreground: oklch(1 0 0)]; --accent: oklch(0.9400 0 0); --accent-foreground: oklch(0 0 0); --secondary: oklch(0.9400 0 0); --ring: oklch(0 0 0). DARK: --primary: oklch(1 0 0) [белый]; --primary-foreground: oklch(0 0 0); --accent: oklch(0.3200 0 0); --secondary: oklch(0.2500 0 0); --ring: oklch(0.7200 0 0). Никакого синего в UI-акцентах темы нет — вся акцентная роль отдана чистому чёрному/белому. Для сравнения — фирменный синий Vercel в самом бренде/Geist (не в этой теме): #0070f3 ("Console Blue"/ссылки), также встречаются #0a72ef (Develop Blue), #0072f5 (Link Blue), focus-цвет hsla(212,100%,48%,1).
- **border:** LIGHT: --border: oklch(0.9200 0 0); --input: oklch(0.9400 0 0). DARK: --border: oklch(0.2600 0 0); --input: oklch(0.3200 0 0). Толщина не задаётся темой напрямую (обычно 1px в shadcn). Для справки, в самом дизайн-языке Vercel/Geist рамки часто эмулируются через box-shadow вместо border: rgba(0,0,0,0.08) 0px 0px 0px 1px (или rgb(235,235,235) 0px 0px 0px 1px для светлого 'ghost'-бордера) — источник: community DESIGN.md по Vercel.
- **dark_bg:** --background: oklch(0 0 0) (чистый чёрный #000000); --foreground: oklch(1 0 0) (чистый белый); --popover: oklch(0.1800 0 0); --muted: oklch(0.2300 0 0); --muted-foreground: oklch(0.7200 0 0); --sidebar: oklch(0.1800 0 0); --sidebar-foreground: oklch(1 0 0)
- **dark_card:** --card: oklch(0.1400 0 0); --card-foreground: oklch(1 0 0)
- **fonts:** --font-sans: "Geist, sans-serif"; --font-mono: "Geist Mono, monospace"; --font-serif: "Georgia, serif" (одинаково в light и dark). --letter-spacing / --tracking-normal: 0em; производные --tracking-tighter/tight/wide/wider/widest вычисляются как calc(var(--tracking-normal) ± 0.025em/0.05em/0.1em). Это соответствует фирменному шрифту Vercel — Geist Sans (для UI) и Geist Mono (для кода) — с характерным отрицательным letter-spacing на крупных заголовках (от -0.32px до -2.88px по мере роста кегля), по данным community-документации Geist Design System.
- **other:** ПОЛНЫЙ НАБОР ТОКЕНОВ tweakcn 'vercel' (light): background oklch(0.9900 0 0); foreground oklch(0 0 0); card oklch(1 0 0); card-foreground oklch(0 0 0); popover oklch(0.9900 0 0); popover-foreground oklch(0 0 0); secondary oklch(0.9400 0 0); secondary-foreground oklch(0 0 0); muted oklch(0.9700 0 0); muted-foreground oklch(0.4400 0 0); destructive oklch(0.6300 0.1900 23.0300); destructive-foreground oklch(1 0 0); chart-1 oklch(0.8100 0.1700 75.3500); chart-2 oklch(0.5500 0.2200 264.5300); chart-3 oklch(0.7200 0 0); chart-4 oklch(0.9200 0 0); chart-5 oklch(0.5600 0 0); sidebar oklch(0.9900 0 0); sidebar-foreground oklch(0 0 0); sidebar-primary oklch(0 0 0); sidebar-primary-foreground oklch(1 0 0); sidebar-accent oklch(0.9400 0 0); sidebar-accent-foreground oklch(0 0 0); sidebar-border oklch(0.9400 0 0); sidebar-ring oklch(0 0 0). DARK доп.: destructive oklch(0.6900 0.2000 23.9100); destructive-foreground oklch(0 0 0); chart-1 oklch(0.8100 0.1700 75.3500); chart-2 oklch(0.5800 0.2100 260.8400); chart-3 oklch(0.5600 0 0); chart-4 oklch(0.4400 0 0); chart-5 oklch(0.9200 0 0); sidebar-primary oklch(1 0 0); sidebar-primary-foreground oklch(0 0 0); sidebar-accent oklch(0.3200 0 0); sidebar-accent-foreground oklch(1 0 0); sidebar-border oklch(0.3200 0 0); sidebar-ring oklch(0.7200 0 0). --spacing (base unit): 0.25rem (=4px). Shadow-переменные-компоненты: --shadow-color: hsl(0 0% 0%); --shadow-opacity: 0.18; --shadow-blur: 2px; --shadow-spread: 0px; --shadow-offset-x: 0px; --shadow-offset-y: 1px (одинаковы в light и dark). Независимо от темы — фирменная шкала отступов Geist: базовая единица 8px, шкала 1/2/3/4/5/6/8/10/12/14/16/32/36/40px (пропуск 20/24px), по community DESIGN.md.
- **radius:** --radius: 0.5rem (=8px) — одинаково в light и dark, задаётся и в theme{}, и продублировано в cssVars.light/dark. Для сравнения — официальная шкала радиусов Geist (не эта тема, а сам бренд Vercel): 2px (micro), 4px (subtle), 6px (standard, по умолчанию для карточек/инпутов), 8px (comfortable), 12px (image), 64px (large), 100px (xl), 9999px (только для pill-кнопок).
- **shadows:** LIGHT и DARK идентичны: --shadow-2xs: 0px 1px 2px 0px hsl(0 0% 0% / 0.09); --shadow-xs: 0px 1px 2px 0px hsl(0 0% 0% / 0.09); --shadow-sm: 0px 1px 2px 0px hsl(0 0% 0% / 0.18), 0px 1px 2px -1px hsl(0 0% 0% / 0.18); --shadow: 0px 1px 2px 0px hsl(0 0% 0% / 0.18), 0px 1px 2px -1px hsl(0 0% 0% / 0.18); --shadow-md: 0px 1px 2px 0px hsl(0 0% 0% / 0.18), 0px 2px 4px -1px hsl(0 0% 0% / 0.18); --shadow-lg: 0px 1px 2px 0px hsl(0 0% 0% / 0.18), 0px 4px 6px -1px hsl(0 0% 0% / 0.18); --shadow-xl: 0px 1px 2px 0px hsl(0 0% 0% / 0.18), 0px 8px 10px -1px hsl(0 0% 0% / 0.18); --shadow-2xl: 0px 1px 2px 0px hsl(0 0% 0% / 0.45). Все тени очень тонкие/малозаметные — соответствует минималистичному языку Vercel, где вместо классических теней часто используется 1px 'shadow-as-border' техника: rgba(0,0,0,0.08) 0px 0px 0px 1px.

Заметки:
- Прямое подтверждение полной идентичности токенов 21st.dev/@serafimcloud/themes/vercel и tweakcn 'vercel.json' получить не удалось техническими средствами (WebFetch не выполняет JS, а API/JSON-эндпоинт конкретно для этой темы на 21st.dev обнаружить не удалось — /r/themes/vercel.json и /r/serafimcloud/vercel.json на 21st.dev вернули 404 или пустые заглушки). Это ВЫВОД/гипотеза с высокой вероятностью, а не подтверждённый факт: сам 21st.dev в своём блоге (21st.dev/blog/free-shadcn-themes) прямо называет 'Vercel' в числе 'brand-derived' тем и упоминает пресеты tweakcn как источник вдохновения/отправную точку для части палитр.
- Файл tweakcn 'vercel' НЕ найден в главном файле пресетов jnsahaj/tweakcn/main/utils/theme-presets.ts (там нет темы с id 'vercel' среди перечисленных ~36 пресетов) — то есть тема 'vercel' в tweakcn публикуется не через этот конкретный файл кода, а как отдельный сгенерированный registry-JSON по адресу https://tweakcn.com/r/themes/vercel.json, который был успешно получен целиком (высокая уверенность в точности этих значений, так как это сырой JSON с сайта).
- Тема 'Vercel' строго монохромна: единственные не-серые цвета во всей палитре — это оттенок destructive (красный, oklch(...23.03) в light и oklch(...23.91) в dark) и два chart-цвета (chart-1 оранжевый/охра oklch(0.81 0.17 75.35), chart-2 синий oklch(0.55 0.22 264.53) в light / oklch(0.58 0.21 260.84) в dark). Никакого фирменного синего #0070f3 в переменных темы нет.
- Официальный vercel.com/geist/colors описывает 10-ступенчатую шкалу серого (gray-100…gray-1000) и акцентные шкалы (blue, red, amber, green, teal, purple, pink) через CSS-переменные вида --ds-gray-900, с поддержкой P3-цветов; конкретные hex-значения на самой официальной странице не раскрываются в виде простого текста (они генерируются JS/скриптами), поэтому все hex-значения бренда Vercel в этом отчёте (например #171717, #0070f3, #ebebeb, #fafafa) взяты из независимых сторонних сборников токенов (community DESIGN.md), а не напрямую со страницы vercel.com/geist — отсюда средняя, а не высокая, уверенность именно для этих hex-чисел.
- Фирменный шрифт официально называется 'Geist' и 'Geist Mono' (ранее известны как 'Vercel Sans'/'Vercel Mono'), что точно совпадает со значениями --font-sans/--font-mono в теме tweakcn 'vercel'.

Источники:
- https://tweakcn.com/r/themes/vercel.json (прямой источник точных токенов, дословный JSON получен через WebFetch)
- https://21st.dev/@serafimcloud/themes/vercel (целевая страница; client-rendered, токены не найдены в статическом HTML)
- https://21st.dev/blog/free-shadcn-themes (упоминание Vercel как 'brand-derived' темы и tweakcn как источника пресетов)
- https://21st.dev/community/themes (общий каталог тем)
- https://raw.githubusercontent.com/jnsahaj/tweakcn/main/utils/theme-presets.ts (проверено — темы 'vercel' в этом конкретном файле нет)
- https://vercel.com/geist/colors (официальная, но частично JS-рендерящаяся страница цветовой системы Geist)
- https://vercel.com/geist/introduction
- https://raw.githubusercontent.com/ItamarZand88/design-skills/main/design-md/vercel/DESIGN.md (сторонний сборник hex/shadow/radius токенов бренда Vercel)
- https://designmd.cc/benchmarks/vercel
- https://github.com/serafimcloud/21st (исходный код платформы 21st.dev)
