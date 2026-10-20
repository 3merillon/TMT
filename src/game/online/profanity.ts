/** Display-only filter. NFKD, confusables, zero-width marks, separators and repeated letters are normalized;
 * matched spans are masked in the original text. Boundaries prevent ordinary words like 'class' from matching. */
const WORDS = ['fuck', 'fucker', 'fucking', 'motherfucker', 'shit', 'shitty', 'bullshit', 'bitch', 'bitches', 'bastard', 'asshole', 'arsehole', 'cunt', 'dickhead', 'cock', 'pussy', 'wanker', 'twat', 'nigger', 'nigga', 'faggot', 'retard', 'retarded', 'scheisse', 'scheiss', 'arschloch', 'wichser', 'hurensohn', 'fotze'];
const ALIASES: Record<string, string> = { '0': 'o', '1': 'i', '!': 'i', '3': 'e', '4': 'a', '@': 'a', '5': 's', '$': 's', '7': 't', '8': 'b', 'а': 'a', 'е': 'e', 'і': 'i', 'о': 'o', 'р': 'p', 'с': 'c', 'х': 'x', 'υ': 'u', 'ѕ': 's', 'ß': 'ss' };
const patterns = WORDS.map(word => new RegExp(`(^|[^a-z])(${[...word].map(c => `${c}+(?:[^a-z]*)`).join('')})(?=$|[^a-z])`, 'g'));
export function filterProfanity(text: string, enabled = true): string {
  if (!enabled) return text;
  let normal = ''; const indices: number[] = [];
  for (let i = 0; i < text.length;) {
    const point = String.fromCodePoint(text.codePointAt(i)!);
    let chars = point.normalize('NFKD').toLowerCase().replace(/[\p{M}\p{Cf}]/gu, '');
    chars = [...chars].map(c => c === '!' && !/[a-z]/i.test(text[i + point.length] ?? '') ? c : ALIASES[c] ?? c).join('');
    for (const c of chars.split('')) { normal += c; indices.push(i); }
    i += point.length;
  }
  const masked = new Set<number>();
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(normal); match; match = pattern.exec(normal)) {
      const start = match.index + match[1].length;
      let end = start + match[2].length; while (end > start && !/[a-z]/.test(normal[end - 1])) end--;
      for (let i = indices[start]; i <= indices[end - 1]; i++) masked.add(i);
    }
  }
  return text.split('').map((c, i) => masked.has(i) && !/\s/.test(c) ? '•' : c).join('');
}
