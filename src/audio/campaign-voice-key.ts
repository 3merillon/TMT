/** Shared by the offline bake and playback. Editorial punctuation never changes a clip's identity. */
export function speechText(text: string): string {
  return text.replace(/[‘’‛]/g, "'").replace(/[“”]/g, '"').replace(/[‐-―]/g, '-').replace(/…/g, '...').replace(/\s+/g, ' ').trim();
}
export function voiceKey(speaker: string, text: string): string {
  let h = 2166136261;
  for (const c of `${speaker}\n${speechText(text)}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (h >>> 0).toString(16).padStart(8, '0');
}
