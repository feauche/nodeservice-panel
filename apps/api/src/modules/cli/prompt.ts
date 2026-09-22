import { createInterface } from 'node:readline';

/** Запрашивает секрет в терминале, не показывая ввод. Из пайпа читает первую строку как есть. */
export function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const output = process.stderr;
    const rl = createInterface({ input, output, terminal: input.isTTY ?? false });
    if (input.isTTY) {
      // Перехватываем вывод readline: печатаем вопрос, а введённые символы — нет.
      const write = output.write.bind(output);
      let muted = false;
      output.write = ((chunk: string | Uint8Array, ...rest: unknown[]) =>
        muted
          ? true
          : (write as (c: string | Uint8Array, ...r: unknown[]) => boolean)(
              chunk,
              ...rest,
            )) as typeof output.write;
      rl.question(question, (answer) => {
        output.write = write;
        write('\n');
        rl.close();
        resolve(answer);
      });
      muted = true;
      return;
    }
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
    rl.on('error', reject);
  });
}
