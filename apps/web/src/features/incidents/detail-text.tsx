import { Fragment, useMemo } from 'react';

import { CountryFlag } from '@/components/country-flag';
import { useServers } from '@/features/servers/servers-api';

/** Строка проверки: «• Мост — порт не отвечает совсем» → имя сервера и остальное. */
const PROBE_LINE = /^(•\s+)(.+?)(\s+—\s.*)$/;

/**
 * Текст дела по строкам (падение онлайна: откуда проверяли и что увидели). В строках проверок перед
 * названием сервера парка — флаг его страны, как в чате Джарвиса: видно, откуда шла проверка.
 */
export function DetailText({ text }: { text: string }) {
  const servers = useServers();
  const countryByName = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of servers.data?.items ?? []) if (s.country.code) m.set(s.name, s.country.code);
    return m;
  }, [servers.data]);
  const lines = text.split('\n');
  return (
    <>
      {lines.map((line, i) => {
        const m = PROBE_LINE.exec(line);
        const code = m ? countryByName.get(m[2] as string) : undefined;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: строки текста без своих id, порядок не меняется
          <Fragment key={i}>
            {m && code ? (
              <>
                {m[1]}
                <CountryFlag code={code} size="sm" decorative className="mr-1.5 inline-block align-[-1px]" />
                {m[2]}
                {m[3]}
              </>
            ) : (
              line
            )}
            {i < lines.length - 1 ? '\n' : ''}
          </Fragment>
        );
      })}
    </>
  );
}
