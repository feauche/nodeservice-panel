import { ChevronLeftIcon, ChevronRightIcon, ChevronsLeftIcon, ChevronsRightIcon } from 'lucide-react';

import { pageButtonClass } from '@/components/pagination';

interface Props {
  /** Показано начало списка — назад листать некуда. */
  atStart: boolean;
  /** Показан конец списка — вперёд листать некуда. */
  atEnd: boolean;
  onFirst: () => void;
  onPrev: () => void;
  onNext: () => void;
  onLast: () => void;
  /** Подпись для скринридера — какой список листаем. */
  label: string;
}

/**
 * Строка страниц реестра «Инциденты». Страницы там разной длины (сколько помещается по высоте окна) и номером
 * не адресуются — любой номер врал бы, поэтому только стрелки; где мы в списке, говорит диапазон слева.
 * Кнопки — те же, что у Pagination.
 */
export function IncidentsPager({ atStart, atEnd, onFirst, onPrev, onNext, onLast, label }: Props) {
  // Весь список на одной странице — листать нечего, как у Pagination с одной страницей.
  if (atStart && atEnd) return null;
  const buttons = [
    { name: 'В начало', Icon: ChevronsLeftIcon, disabled: atStart, onClick: onFirst },
    { name: 'Предыдущая', Icon: ChevronLeftIcon, disabled: atStart, onClick: onPrev },
    { name: 'Следующая', Icon: ChevronRightIcon, disabled: atEnd, onClick: onNext },
    { name: 'В конец', Icon: ChevronsRightIcon, disabled: atEnd, onClick: onLast },
  ];
  return (
    <nav aria-label={label} className="flex items-center gap-1">
      {buttons.map(({ name, Icon, disabled, onClick }) => (
        <button
          key={name}
          type="button"
          className={pageButtonClass}
          disabled={disabled}
          onClick={onClick}
          aria-label={name}
          title={name}
        >
          <Icon className="size-4" />
        </button>
      ))}
    </nav>
  );
}
