/**
 * Icons users pick for habits, finance categories and Books are a single emoji: one grapheme
 * cluster that is pictographic, a flag (two regional indicators) or a keycap (1️⃣). ZWJ sequences
 * and skin tones are one grapheme too. Never text, markup or SVG, so nothing arbitrary is ever
 * stored or rendered as an icon. At most 16 code points (the database's limit).
 */
export function isSingleEmoji(value: string): boolean {
  if (!value || [...value].length > 16) return false;
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)];
  return (
    graphemes.length === 1 &&
    (/\p{Extended_Pictographic}/u.test(value) ||
      /^\p{Regional_Indicator}{2}$/u.test(value) ||
      /^[0-9#*]️?⃣$/u.test(value))
  );
}
