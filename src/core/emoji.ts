/**
 * Icons users pick for habits, finance categories and Books are a single emoji: one grapheme
 * cluster with a pictographic character. Never text, markup or SVG, so nothing arbitrary is ever
 * stored or rendered as an icon.
 */
export function isSingleEmoji(value: string): boolean {
  if (!value || value.length > 16) return false;
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)];
  return graphemes.length === 1 && /\p{Extended_Pictographic}/u.test(value);
}
