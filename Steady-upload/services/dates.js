export function localDay(date, timezone) {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const part = name => parts.find(item => item.type === name).value;
  return [part('year').padStart(4, '0'), part('month'), part('day')].join('-');
}
export function validDay(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const parsed = new Date(day);
  return !Number.isNaN(+parsed) && parsed.toISOString().slice(0, 10) === day && day >= '0001-01-01';
}
export function offset(day, count) {
  const date = new Date(day);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}
export function weekStart(day) {
  return offset(day, -((new Date(day).getUTCDay() + 6) % 7));
}
export function validWeek(week) {
  return validDay(week) && week >= '0002-01-01' && weekStart(week) === week;
}
export function validMonth(month) {
  return typeof month === 'string' && validDay(month + '-01') && month >= '0002-01' && month <= '9998-12';
}
export function monthInfo(month) {
  const first = new Date(month + '-01');
  const last = new Date(first);
  last.setUTCMonth(last.getUTCMonth() + 1, 0);
  return {
    title: new Intl.DateTimeFormat('en', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(first),
    padding: (first.getUTCDay() + 6) % 7,
    previous: offset(month + '-01', -1).slice(0, 7),
    next: offset(last.toISOString().slice(0, 10), 1).slice(0, 7),
    dates: Array.from({ length: last.getUTCDate() }, (_, index) => offset(month + '-01', index))
  };
}
export function dateLabel(day) {
  return new Intl.DateTimeFormat('en', { dateStyle: 'full', timeZone: 'UTC' }).format(new Date(day));
}
export const percent = (count, total) => total ? Math.round(count / total * 100) : 0;

export function streaks(rows, today) {
  let current = 0;
  let longest = 0;
  for (const row of rows) {
    if (row.full) longest = Math.max(longest, ++current);
    else if (row.day !== today) current = 0;
  }
  return { current, longest };
}

