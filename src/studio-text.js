'use strict';

const DEFAULT_STYLE = '平静自然地朗读，语速适中，按标点自然停顿。';

// Keep every character, including whitespace, so concatenating the segments is
// exactly the saved source. Prefer paragraph/sentence boundaries near the target.
function splitText(source, target = 1000) {
  if (typeof source !== 'string') throw new Error('请粘贴朗读正文');
  const text = source.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim();
  const chars = Array.from(text);
  if (!chars.length || chars.length > 100000) throw new Error('正文需要 1～100,000 字');
  if (!Number.isInteger(target) || target < 500 || target > 1600) throw new Error('每段长度需要在 500～1,600 字之间');
  const segments = [];
  let start = 0;
  while (start < chars.length) {
    let end = Math.min(start + target, chars.length);
    if (end < chars.length) {
      const floor = start + Math.floor(target * 0.55);
      let paragraph = 0, sentence = 0;
      for (let i = floor; i < end; i++) {
        if (chars[i] === '\n') paragraph = i + 1;
        if (/[。！？!?；;]/.test(chars[i]) || (chars[i] === '.' && /\s/.test(chars[i + 1]))) {
          sentence = i + 1;
          while (sentence < end && /[”’」』）)\s]/.test(chars[sentence])) sentence++;
        }
      }
      end = paragraph || sentence || end;
    }
    segments.push(chars.slice(start, end).join(''));
    start = end;
  }
  return { text, segments, characterCount: chars.length };
}

module.exports = { splitText, DEFAULT_STYLE };
