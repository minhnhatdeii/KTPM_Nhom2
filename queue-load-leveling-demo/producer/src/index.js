const express = require('express');
const amqplib = require('amqplib');
const crypto = require('crypto');

const AMQP_URL   = process.env.AMQP_URL   || 'amqp://localhost';
const QUEUE_MAIN = process.env.QUEUE_MAIN || 'jobs';
const QUEUE_DLQ  = process.env.QUEUE_DLQ  || 'jobs.dlq';

const app = express();
app.use(express.json());

let ch; // channel holder

async function connectWithRetry(maxAttempts = 50, delayMs = 1000) {
  let attempt = 0;
  while (true) {
    try {
      const conn = await amqplib.connect(AMQP_URL);
      const channel = await conn.createChannel();
      await channel.assertQueue(QUEUE_DLQ,  { durable: true });
      await channel.assertQueue(QUEUE_MAIN, { durable: true, deadLetterExchange: '', deadLetterRoutingKey: QUEUE_DLQ });
      console.log('[producer] Connected to RabbitMQ');
      return channel;
    } catch (e) {
      attempt++;
      if (attempt >= maxAttempts) throw e;
      console.log(`[producer] RabbitMQ not ready. Retry in ${delayMs}ms... (${attempt}/${maxAttempts})`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

(async () => {
  ch = await connectWithRetry();
})();

// Burst API: send N jobs in one request
app.get('/burst', async (req, res) => {
  try {
    const count = Math.max(1, Number(req.query.count || 100));
    const topic = String(req.query.topic || 'thumbnail.create');

    for (let i = 0; i < count; i++) {
      const jobKey = crypto.createHash('md5').update(`${topic}:${Date.now()}:${i}:${Math.random()}`).digest('hex');
      const msg = {
        topic,
        job_key: jobKey,      // idempotency key
        payload: {
          image_url: `https://example.com/img/${i}.jpg`,
          sizes: [128, 256, 512]
        },
        meta: { attempt: 0, created_at: Date.now() }
      };
      ch.sendToQueue(QUEUE_MAIN, Buffer.from(JSON.stringify(msg)), {
        persistent: true,
        contentType: 'application/json',
        headers: { 'x-job-key': jobKey }
      });
    }
    res.send(`Queued ${count} jobs for topic="${topic}"`);
  } catch (err) {
    console.error('[producer] burst error', err);
    res.status(500).send('error');
  }
});

// Simple depth metrics
app.get('/metrics', async (_req, res) => {
  try {
    const q = await ch.checkQueue(QUEUE_MAIN);
    const dlq = await ch.checkQueue(QUEUE_DLQ);
    res.json({ queue_depth: q.messageCount, dlq_depth: dlq.messageCount });
  } catch (err) {
    res.status(503).json({ error: 'channel-not-ready' });
  }
});

app.listen(3000, () => console.log('[producer] http://localhost:3000'));
