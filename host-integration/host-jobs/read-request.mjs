export async function readRequest(input, { timeoutMs = 10000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('invalid request deadline');
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('request deadline exceeded'));
      input.destroy?.();
    }, timeoutMs);
  });
  try { return await Promise.race([consume(input), deadline]); }
  finally { clearTimeout(timer); }
}

async function consume(input) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 65536) throw new Error('request too large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
