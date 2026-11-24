import { validDay, validMonth } from './dates.js';

const months = ['january','february','march','april','may','june','july','august','september','october','november','december'];
const monthNumber = word => {
  const index = months.findIndex(month => month === word || month.slice(0, 3) === word);
  return index < 0 ? null : String(index + 1).padStart(2, '0');
};
const pad = value => value.padStart(2, '0');

export function dateQuery(query) {
  if (validDay(query)) return date => date === query;
  if (validMonth(query)) return date => date.startsWith(query);
  if (/^\d{4}$/.test(query)) return date => date.slice(0, 4) === query;
  if (/^\d{1,2}$/.test(query) && +query >= 1 && +query <= 31) return date => date.slice(8) === pad(query);
  const exact = /^(\d{1,2}) ([a-z]+)(?: (\d{4}))?$/.exec(query);
  if (exact) {
    const [, day, word, year] = exact;
    const month = monthNumber(word);
    if (month && validDay((year || '2000') + '-' + month + '-' + pad(day))) {
      return date => (!year || date.slice(0, 4) === year) && date.slice(5) === month + '-' + pad(day);
    }
  }
  const period = /^([a-z]+) (\d{4})$/.exec(query);
  if (period) {
    const month = monthNumber(period[1]);
    if (month) return date => date.startsWith(period[2] + '-' + month);
  }
  return null;
}

export function writingPreview(body, match) {
  if (match) {
    const start = Math.max(0, match.index - 45);
    const end = Math.min(body.length, start + Math.max(155, match.index - start + match[0].length + 30));
    const excerpt = body.slice(start, end).trim().replace(/\s+/g, ' ');
    return (start ? '\u2026' : '') + excerpt + (end < body.length ? '\u2026' : '');
  }
  const compact = body.trim().replace(/\s+/g, ' ');
  const characters = [...compact.slice(0, 320)];
  return characters.length > 155 ? characters.slice(0, 155).join('') + '…' : compact;
}

