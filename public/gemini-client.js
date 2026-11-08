'use strict';
(function (root, factory) {
  const value = factory();
  if (typeof module === 'object' && module.exports) module.exports = value;
  else root.JtgGemini = value;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const MODEL = 'gemini-3.8-flash-tts';
  const API = 'https://generativelanguage.googleapis.com/v1beta';
  const MAX_RESPONSE = 80 * 1024 * 1024;
  function failure(reason, message, status) { return Object.assign(new Error(message), { reason, status }); }
  function key(value) {
    const result = String(value || '').trim();
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(result)) throw failure('access', '请填写有效的 Gemini API Key');
    return result;
  }
  function body({ text, voice, style }) {
    if (!text || Array.from(text).length > 1600 || !['Charon', 'Orus', 'Algenib'].includes(voice)) throw failure('audio', '正文或声音设置无效');
    return { model: MODEL, store: false,
      input: [{ type: 'user_input', content: [{ type: 'text', text, annotations: [{ type: 'speech_metadata', style }] }] }],
      response_format: { type: 'audio', mime_type: 'audio/wav' },
      generation_config: { speech_config: [{ voice }] } };
  }
  function statusError(status) {
    if (status === 429) return failure('quota', 'Gemini 的免费额度或速率限制已触发。请稍后继续，已经完成的分段会保留。', status);
    if ([400, 401, 403, 404].includes(status)) return failure('access', 'Google 未接受请求，请检查密钥、免费项目权限及所在地区是否可用。', status);
    return failure('connection', 'Gemini 暂时无法完成请求，任务已暂停，可以稍后继续。', status);
  }
  async function fetchGoogle(path, apiKey, options = {}, fetchFn = fetch) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180000);
    const aborted = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    options.signal?.addEventListener('abort', aborted, { once: true });
    try {
      const response = await fetchFn(API + path, { method: options.body ? 'POST' : 'GET',
        headers: { 'x-goog-api-key': key(apiKey), ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal });
      if (!response.ok) { try { await response.body?.cancel(); } catch {} throw statusError(response.status); }
      if (Number(response.headers.get('content-length')) > MAX_RESPONSE) throw failure('audio', '生成结果过大，请把文章分成更短的段落');
      const reader = response.body.getReader(); let size = 0; const chunks = [];
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.length;
        if (size > MAX_RESPONSE) { await reader.cancel(); throw failure('audio', '生成结果过大，请把文章分成更短的段落'); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      try { return JSON.parse(new TextDecoder().decode(bytes)); }
      catch { throw failure('audio', 'Google 返回的结果无法读取，请稍后重试'); }
    } catch (error) {
      if (error.reason) throw error;
      throw failure('connection', '无法连接 Gemini 或请求超时，请确认当前浏览器可以访问 Google，再继续生成。');
    } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', aborted); }
  }
  async function connect(apiKey, fetchFn = fetch) {
    await fetchGoogle(`/models/${MODEL}`, apiKey, {}, fetchFn);
    // Authentication/model access can be checked; billing tier cannot be inferred
    // from an API key. The owner must explicitly confirm an unbilled project.
    return true;
  }
  function decode(result) {
    if (result.status !== 'completed') throw failure('audio', '本段未完整生成，请稍后重试');
    const outputs = (result.steps || []).filter(s => s.type === 'model_output').flatMap(s => s.content || []).filter(c => c.type === 'audio');
    const audio = outputs.at(-1);
    if (!audio?.data || typeof audio.data !== 'string' || audio.data.length > MAX_RESPONSE || !/^[A-Za-z0-9+/]*={0,2}$/.test(audio.data)) throw failure('audio', '没有收到完整的语音文件');
    if (audio.mime_type && audio.mime_type !== 'audio/wav') throw failure('audio', 'Google 返回的声音格式发生变化，请先使用手动上传');
    let bytes;
    try { const binary = atob(audio.data); bytes = Uint8Array.from(binary, c => c.charCodeAt(0)); }
    catch { throw failure('audio', '语音文件无法读取'); }
    const tag = (a, b) => String.fromCharCode(...bytes.subarray(a, b));
    if (bytes.length < 44 || tag(0, 4) !== 'RIFF' || tag(8, 12) !== 'WAVE') throw failure('audio', '未收到有效的 WAV 语音，请稍后重试');
    return new Blob([bytes], { type: 'audio/wav' });
  }
  async function generate(options, fetchFn = fetch) {
    return decode(await fetchGoogle('/interactions', options.apiKey, { body: body(options), signal: options.signal }, fetchFn));
  }
  return { MODEL, key, body, decode, connect, generate };
});
