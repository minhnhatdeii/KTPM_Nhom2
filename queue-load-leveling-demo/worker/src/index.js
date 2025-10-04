const amqplib = require('amqplib');

const AMQP_URL   = process.env.AMQP_URL   || 'amqp://localhost';
const QUEUE_MAIN = process.env.QUEUE_MAIN || 'jobs';
const QUEUE_DLQ  = process.env.QUEUE_DLQ  || 'jobs.dlq';
const PROCESS_MS = Number(process.env.PROCESS_MS || 600);
const MAX_RETRY  = Number(process.env.MAX_RETRY  || 5);
const PREFETCH   = Number(process.env.PREFETCH   || 1);
const FAILURE_RATE_PCT = Number(process.env.FAILURE_RATE_PCT || 0);

let processed = 0, failed = 0, dlqCount = 0, retries = 0;
const seen = new Set(); // demo idempotency (in-memory)

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomFail() { return Math.random()*100 < FAILURE_RATE_PCT; }
function backoff(attempt) { return Math.min(5000, Math.pow(2, attempt) * 100); } // exp, cap 5s

async function connectWithRetry(maxAttempts = 50, delayMs = 1000) {
  let attempt = 0;
  while (true) {
    try {
      const conn = await amqplib.connect(AMQP_URL);
      const ch = await conn.createChannel();
      await ch.assertQueue(QUEUE_DLQ,  { durable: true });
      await ch.assertQueue(QUEUE_MAIN, { durable: true, deadLetterExchange: '', deadLetterRoutingKey: QUEUE_DLQ });
      ch.prefetch(PREFETCH);
      console.log('[worker] Connected to RabbitMQ', { PROCESS_MS, MAX_RETRY, PREFETCH, FAILURE_RATE_PCT });
      return ch;
    } catch (e) {
      attempt++;
      if (attempt >= maxAttempts) throw e;
      console.log(`[worker] RabbitMQ not ready. Retry in ${delayMs}ms... (${attempt}/${maxAttempts})`);
      await sleep(delayMs);
    }
  }
}

(async () => {
  const ch = await connectWithRetry();

  ch.consume(QUEUE_MAIN, async (msg) => {
    if (!msg) return;
    let job;
    try {
      job = JSON.parse(msg.content.toString());
    } catch {
      // malformed -> DLQ
      dlqCount++;
      ch.sendToQueue(QUEUE_DLQ, msg.content, { persistent: true, contentType: 'application/json', headers: { 'x-dead-letter': 'malformed' }});
      ch.ack(msg);
      return;
    }

    const key = job.job_key;

    // Idempotency (demo): skip if already seen
    if (seen.has(key)) {
      console.log('[worker] skip duplicate', key);
      ch.ack(msg);
      return;
    }

    try {
      // Simulate processing (e.g., thumbnailing)
      await sleep(PROCESS_MS);

      if (randomFail()) throw new Error('random processing error');

      // Success
      processed++;
      seen.add(key);
      if (processed % 50 === 0) {
        console.log(`[worker] processed=${processed} failed=${failed} retries=${retries} dlq=${dlqCount}`);
      }
      ch.ack(msg);

    } catch (err) {
      const attempt = (job.meta?.attempt || 0) + 1;
      if (attempt <= MAX_RETRY) {
        retries++;
        const delayMs = backoff(attempt);
        // delayed retry by sleep + requeue (simple demo)
        await sleep(delayMs);
        job.meta = { ...(job.meta||{}), attempt };
        ch.sendToQueue(QUEUE_MAIN, Buffer.from(JSON.stringify(job)), {
          persistent: true,
          contentType: 'application/json',
          headers: { 'x-job-key': key }
        });
        ch.ack(msg); // ack old copy
        console.log(`[worker] retry attempt=${attempt} key=${key} after=${delayMs}ms`);
      } else {
        failed++;
        dlqCount++;
        ch.sendToQueue(QUEUE_DLQ, Buffer.from(JSON.stringify(job)), {
          persistent: true,
          contentType: 'application/json',
          headers: { 'x-job-key': key, 'x-dead-letter': 'max-retry' }
        });
        ch.ack(msg);
        console.warn(`[worker] sent to DLQ key=${key}`);
      }
    }
  });

  // Log metrics periodically
  setInterval(async () => {
    try {
      const q = await ch.checkQueue(QUEUE_MAIN);
      const dlq = await ch.checkQueue(QUEUE_DLQ);
      console.log(`[metrics] queue=${q.messageCount} dlq=${dlq.messageCount} processed=${processed} failed=${failed} retries=${retries}`);
    } catch {}
  }, 3000);
})();
