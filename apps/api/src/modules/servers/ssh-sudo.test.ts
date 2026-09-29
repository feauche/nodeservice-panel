import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { errorText } from '../../common/filters/problem-details.filter.js';
import { serverProblems, stripAnsi } from './servers.problems.js';
import { shellQuote, sudoAdvice } from './ssh.service.js';

describe('команды через sudo для пользователя не root', () => {
  it('команда целиком, с кавычками, $ и конвейером, доходит до sh без изменений', () => {
    const cmd = `echo "q'uote $HOME" | tr a-z A-Z; printf '%s' 'x'`;
    const direct = execFileSync('sh', ['-c', cmd], { encoding: 'utf8' });
    const viaQuote = execFileSync('sh', ['-c', `sh -c ${shellQuote(cmd)}`], { encoding: 'utf8' });
    expect(viaQuote).toBe(direct);
  });

  it('понятная причина, почему sudo не пустил', () => {
    expect(sudoAdvice('sudo: a password is required', 'ubuntu')).toMatch(/NOPASSWD/);
    expect(sudoAdvice('sh: sudo: command not found', 'ubuntu')).toMatch(/нет sudo/);
    expect(sudoAdvice('ubuntu is not in the sudoers file', 'ubuntu')).toMatch(/sudoers/);
  });
});

describe('сообщения об ошибках команд', () => {
  it('коды цвета из вывода скрипта не попадают в текст', () => {
    expect(stripAnsi('\u001b[31m✗ запусти от root\u001b[0m')).toBe('✗ запусти от root');
    expect(errorText(serverProblems.sshCommand('install.sh', '\u001b[31m✗ ошибка\u001b[0m\n'))).toBe(
      'Команда на сервере не выполнилась (install.sh): ✗ ошибка',
    );
  });

  it('в Журнал — текст ошибки, а не «Http Exception»', () => {
    expect(errorText(serverProblems.sshAuth())).toBe('Пароль или ключ не подошли.');
    expect(errorText(new Error('обрыв'))).toBe('обрыв');
  });
});
