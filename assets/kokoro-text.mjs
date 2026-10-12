// Keep nearby sentences in one synthesis request. Kokoro has noticeable
// per-request overhead on slower devices; sentence-sized requests can leave
// audible gaps even when each individual sentence sounds fine.
export function splitKokoroText(text, maxLength = 320) {
  const sentences = String(text).match(/[^.!?]+[.!?]+["')\]}]*|[^.!?]+$/g) || [String(text)];
  const pieces = [];
  for (const sentence of sentences) {
    let remainder = sentence.trim();
    while (remainder.length > maxLength) {
      let splitAt = remainder.lastIndexOf(' ', maxLength);
      if (splitAt < Math.floor(maxLength * 0.55)) splitAt = maxLength;
      pieces.push(remainder.slice(0, splitAt).trim());
      remainder = remainder.slice(splitAt).trim();
    }
    if (remainder) pieces.push(remainder);
  }

  const chunks = [];
  let current = '';
  for (const piece of pieces) {
    if (!current) {
      current = piece;
    } else if (current.length + 1 + piece.length <= maxLength) {
      current += ` ${piece}`;
    } else {
      chunks.push(current);
      current = piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
