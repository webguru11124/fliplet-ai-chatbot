require('dotenv').config();

const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const FlipletAPI = require('./fliplet-api');
const { buildTools, executeTool } = require('./tools');

// ── Config ──────────────────────────────────────────────────────────────────

const {
  ANTHROPIC_API_KEY,
  FLIPLET_API_TOKEN,
  FLIPLET_APP_ID,
  PORT = '3000',
} = process.env;

const missing = ['ANTHROPIC_API_KEY', 'FLIPLET_API_TOKEN', 'FLIPLET_APP_ID']
  .filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing env vars: ${missing.join(', ')}. See .env.example`);
  process.exit(1);
}

const MODEL = 'claude-sonnet-4-20250514';
const MAX_TOOL_ROUNDS = 10;

// Keep conversation history from ballooning — we only send the last N messages
// to Claude. Older context gets dropped. This keeps latency and cost stable
// even in long sessions.
const MAX_HISTORY_MESSAGES = 40;

// ── Clients ─────────────────────────────────────────────────────────────────

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const fliplet = new FlipletAPI(FLIPLET_API_TOKEN);
const tools = buildTools(FLIPLET_APP_ID);

const SYSTEM = [
  `You are an expert assistant for Fliplet app ${FLIPLET_APP_ID}.`,
  'You answer questions about the app\'s data sources, entries, media files, and configuration.',
  'Always call tools to get live data — never guess or fabricate API responses.',
  'When presenting data, use concise tables or bullet lists. Avoid dumping raw JSON unless the user asks.',
  'If a data source has been truncated, mention the total count and offer to narrow down.',
].join(' ');

// ── Express ─────────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

// Health check — useful for CLI pre-flight and uptime monitors.
app.get('/health', (_req, res) => res.json({ ok: true, appId: FLIPLET_APP_ID }));

// Standard request/response chat endpoint.
app.post('/api/chat', async (req, res) => {
  try {
    const { message, history = [] } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });

    const messages = trimHistory([...history, { role: 'user', content: message }]);
    const { reply, updatedMessages } = await agentLoop(messages);
    res.json({ reply, history: updatedMessages });
  } catch (err) {
    console.error('[chat]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// SSE streaming chat — the CLI uses this for real-time token output.
app.post('/api/chat/stream', async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message) return res.status(400).json({ error: 'message is required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    const messages = trimHistory([...history, { role: 'user', content: message }]);
    const { reply, updatedMessages } = await agentLoop(messages, (ev) => {
      if (ev.type === 'text_delta') send('delta', { text: ev.text });
      if (ev.type === 'tool_start') send('tool', { name: ev.name, input: ev.input });
    });
    send('done', { reply, history: updatedMessages });
  } catch (err) {
    send('error', { message: err.message });
  } finally {
    res.end();
  }
});

// ── Agent loop ──────────────────────────────────────────────────────────────

async function agentLoop(messages, onEvent) {
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const useStream = !!onEvent;
    let response;

    if (useStream) {
      response = await streamedRequest(messages, onEvent);
    } else {
      response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 4096,
        system: SYSTEM,
        tools,
        messages,
      });
    }

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      const reply = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      return { reply, updatedMessages: messages };
    }

    if (response.stop_reason === 'tool_use') {
      const toolResults = [];
      for (const block of response.content.filter((b) => b.type === 'tool_use')) {
        if (onEvent) onEvent({ type: 'tool_start', name: block.name, input: block.input });
        console.log(`  ↪ ${block.name}(${JSON.stringify(block.input)})`);
        try {
          const result = await executeTool(block.name, block.input, fliplet, FLIPLET_APP_ID);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result),
          });
        } catch (err) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify({ error: err.message }),
            is_error: true,
          });
        }
      }
      messages.push({ role: 'user', content: toolResults });
    }
  }

  return {
    reply: 'Hit the tool-call limit. Try a more specific question.',
    updatedMessages: messages,
  };
}

// Consume a streaming response and reconstruct the same shape as a non-streamed one,
// while emitting text deltas to the callback for real-time output.
async function streamedRequest(messages, onEvent) {
  const stream = anthropic.messages.stream({
    model: MODEL,
    max_tokens: 4096,
    system: SYSTEM,
    tools,
    messages,
  });

  stream.on('text', (text) => onEvent({ type: 'text_delta', text }));

  const finalMessage = await stream.finalMessage();
  return finalMessage;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function trimHistory(messages) {
  if (messages.length <= MAX_HISTORY_MESSAGES) return messages;
  // Always keep the latest user message. Drop oldest pairs.
  return messages.slice(-MAX_HISTORY_MESSAGES);
}

// ── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n  Fliplet AI Chatbot → http://localhost:${PORT}`);
  console.log(`  App ${FLIPLET_APP_ID} · ${MODEL}\n`);
});
