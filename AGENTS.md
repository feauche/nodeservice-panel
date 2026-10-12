# NodeService collaboration rules

## UI workflow

- Before changing any production UI, first create and present an interactive showcase with 3–5 distinct visual variants.
- Put local showcases in `_dev/design/` and keep them visually consistent with the current NodeService design system.
- Do not implement the production UI until the user has selected a variant. A direct user instruction to skip the showcase is the only exception.
- Include the relevant desktop and mobile behavior in the showcase or describe it explicitly when the responsive behavior is shared by all variants.

## Release bookkeeping

- Every completed product change must update the panel version, `packages/shared/src/changelog.ts`, and the local audit report together.
- Do not create a release tag unless the user explicitly asks to release.

## Owner design preferences

- Симметрия, эргономичность, красота и эстетика — приоритет владельца. В одной панели управления кнопки и поля должны иметь одинаковые высоту, ширину ячеек, радиус и отступы. Проверять фактическую геометрию в браузере, а не только CSS-классы. Иконковые действия в своей группе — одинаковые квадратные кнопки. Не смешивать размеры общих компонентов без явного контекстного основания.

- Эталон оформления — существующий стиль этой панели, а не новый внешний дизайн. Для форм сохранения использовать тёмную полосу `bg-bg-2`, как в добавлении записи биллинга: симметричные отступы, основные действия одинаковой высоты 40 px. Компактные панели инструментов не увеличивать глобально. Цвета брать из токенов текущей темы.

- Preserve symmetry: equal input heights, aligned labels, consistent gaps and full available page width.
- Node dialogs keep a fixed outer size across tabs; scroll inside. Verify dropdowns and folder menus at desktop/mobile sizes without clipping or layout shifts.

- Reuse the existing panel components and original GitHub design across sections; do not introduce a separate visual system. DNS automation belongs in each record row. Multi-selection offers select all/clear. Interactive rows/cards show hover/focus and dialogs open immediately with loading placeholders.
