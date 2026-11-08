'use strict';

const { execFile, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const run = promisify(execFile);
const MAX_SECONDS = 20 * 60;
// Exclude playlist/container demuxers that can load arbitrary referenced files.
const INPUT = ['-protocol_whitelist', 'file,pipe', '-format_whitelist', 'wav,mp3,mov,ogg,flac,aac,matroska,webm'];

function available() {
  return ['ffmpeg', 'ffprobe'].every(bin => spawnSync(bin, ['-version'], { timeout: 5000, stdio: 'ignore' }).status === 0);
}

async function probe(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', ...INPUT, '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file], { timeout: 20000, maxBuffer: 128 * 1024 });
  const data = JSON.parse(stdout);
  if (!data.streams?.some(s => s.codec_type === 'audio')) throw new Error('文件中没有可用的声音');
  return Number(data.format?.duration);
}

async function digest(file) {
  const hash = crypto.createHash('sha256');
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}

async function checkAudio(input, output, text) {
  try {
    const duration = await probe(input);
    if (Number.isFinite(duration) && duration > MAX_SECONDS) throw new Error('每段音频最多 20 分钟，请先拆短');
    // Decode the entire input, rejecting decoding errors. The extra second lets
    // us detect unknown/misreported long inputs without unbounded expansion.
    const { stderr } = await run('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'info', '-xerror', '-threads', '1', '-filter_threads', '1', ...INPUT, '-i', input,
      '-map', '0:a:0', '-vn', '-t', String(MAX_SECONDS + 1), '-ac', '1', '-ar', '24000',
      '-af', 'silencedetect=noise=-45dB:d=3', '-c:a', 'pcm_s16le', '-threads', '1', '-y', output], { timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
    const actual = await probe(output);
    if (!Number.isFinite(actual) || actual < 0.25) throw new Error('音频太短或无法完整读取');
    if (actual > MAX_SECONDS) throw new Error('每段音频最多 20 分钟，请先拆短');
    const gaps = [...stderr.matchAll(/silence_duration: ([\d.]+)/g)].map(m => Number(m[1]));
    const warnings = [];
    const characters = Array.from(text.replace(/\s/g, '')).length;
    const pace = characters / (actual / 60);
    if (pace > 600) warnings.push('音频相对正文偏短，请重点核对末尾和是否漏读。');
    if (pace < 100 && characters > 50) warnings.push('音频相对正文偏长，请检查是否重复朗读或停顿过多。');
    if (gaps.length) warnings.push(`发现 ${gaps.length} 处至少 3 秒的静音，最长 ${Math.max(...gaps).toFixed(1)} 秒，请试听确认。`);
    if (gaps.reduce((a, b) => a + b, 0) > actual * 0.85) throw new Error('音频大部分是静音，请重新生成');
    return { durationSeconds: actual, warnings, hash: await digest(output), sizeBytes: fs.statSync(output).size };
  } catch (err) {
    if (!err.code && !err.killed && !err.cmd) throw err;
    throw new Error('音频检查未完成：文件可能损坏、格式不支持或处理超时，请重新上传');
  }
}

async function mergeAudio(manifest, output) {
  // Only internally generated PCM paths enter the manifest. One normalization
  // pass on the whole book preserves natural differences between sentences.
  await run('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-xerror', '-threads', '1', '-filter_threads', '1', '-f', 'concat', '-safe', '1',
    '-protocol_whitelist', 'file,pipe', '-i', manifest, '-map', '0:a:0', '-vn',
    '-af', 'loudnorm=I=-18:TP=-2:LRA=11', '-ar', '24000', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '96k',
    '-map_metadata', '-1', '-threads', '1', '-y', output], { timeout: 15 * 60 * 1000, maxBuffer: 1024 * 1024 });
  const durationSeconds = await probe(output);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error('合并结果无法读取');
  return { durationSeconds, sizeBytes: fs.statSync(output).size };
}

module.exports = { available, checkAudio, mergeAudio };
