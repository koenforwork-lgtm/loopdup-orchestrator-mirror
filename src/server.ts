// src/server.ts
import express from 'express';
import chatwootWebhook from './webhooks/chatwoot_webhook';
import messengerWebhook from './webhooks/messenger_webhook';
import { autoResumeDueConversations } from './repos/conv_state_repo';

const PORT = Number(process.env.PORT || 3110);

const app = express();
app.use(express.json());
app.get('/healthz', (_, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.use('/webhooks', chatwootWebhook);
app.use('/webhooks', messengerWebhook);

// Background auto-resume tick (safety net)
setInterval(async () => {
  try {
    const changed = await autoResumeDueConversations();
    if (changed.length > 0) {
      console.log('[auto-resume]', changed.length, 'conversations resumed');
    }
  } catch (_) {}
}, 30_000);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`LoopdUp Orchestrator running on http://0.0.0.0:${PORT}`);
  console.log(`[routes] [ 'GET /healthz', 'POST /webhooks/chatwoot', 'GET /webhooks/messenger', 'POST /webhooks/messenger' ]`);
});
