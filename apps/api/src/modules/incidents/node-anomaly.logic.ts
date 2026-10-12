/** «за 1 минуту», «за 3 минуты», «за 12 минут». */
export function minutesText(n: number): string {
  const few = n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20);
  return `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'минуту' : few ? 'минуты' : 'минут'}`;
}
