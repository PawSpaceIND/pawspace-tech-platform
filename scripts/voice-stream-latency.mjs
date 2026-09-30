// Consume each synthetic OpenAI SSE event once; timing is model evidence, not handset latency.
export async function measureVoiceStream(response, startedAt, now = Date.now) {
  if (!response.ok || !response.body) throw Error('Voice model stream unavailable');
  const headersMs = now() - startedAt;
  let firstDeltaMs = null, firstSentenceMs = null, text = '', buffer = '', completed = false;
  const decoder = new TextDecoder();
  function consume(line) {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let event;
    try { event = JSON.parse(payload); } catch { throw Error('Malformed voice model stream event'); }
    if (event.type === 'error' || event.type === 'response.failed' || event.type === 'response.incomplete') throw Error('Voice model stream failed');
    if (event.type === 'response.completed') completed = true;
    if (event.type !== 'response.output_text.delta' || typeof event.delta !== 'string' || !event.delta) return;
    if (firstDeltaMs === null) firstDeltaMs = now() - startedAt;
    text += event.delta;
    if (firstSentenceMs === null && /[.!?](?:\s|$)/.test(text)) firstSentenceMs = now() - startedAt;
  }
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, {stream: true});
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) consume(line);
  }
  buffer += decoder.decode();
  if (buffer.trim()) consume(buffer);
  if (!completed || firstDeltaMs === null) throw Error('Voice model stream did not complete with speech');
  return {status: response.status, headersMs, firstDeltaMs, firstSentenceMs,
    totalMs: now() - startedAt, replyChars: text.length, replyPrefix: text.slice(0, 120)};
}
