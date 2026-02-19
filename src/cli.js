#!/usr/bin/env node

// ── Fliplet AI Chatbot — CLI ────────────────────────────────────────────────
//
// Two modes:
//   npm run chat          → talks to the Express server (must be running)
//   npm run chat:direct   → talks to Claude directly, no server needed
//
// The direct mode is handy for quick testing without spinning up Express.

require('dotenv').config();

const readline = require('readline');

// ANSI helpers — zero dependencies, works everywhere.
const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const DIRECT = process.argv.includes('--direct');
const SERVER = process.env.SERVER_URL || 'http://localhost:3000';

let history = [];

// ── Spinner ─────────────────────────────────────────────────────────────────

const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinnerTimer = null;
let spinnerFrame = 0;

function startSpinner(label = 'Thinking') {
  spinnerFrame = 0;
  spinnerTimer = setInterval(() => {
    process.stdout.write(`\r${c.cyan(frames[spinnerFrame++ % frames.length])} ${c.dim(label)}  `);
  }, 80);
}

function stopSpinner() {
  if (spinnerTimer) {
    clearInterval(spinnerTimer);
    spinnerTimer = null;
    process.stdout.write('\r\x1b[K'); // clear the line
  }
}

// ── Server mode (SSE streaming) ─────────────────────────────────────────────

async function chatViaServer(message) {
  const res = await fetch(`${SERVER}/api/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, history }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Server ${res.status}: ${err}`);
  }

  stopSpinner();
  process.stdout.write(`\n${c.green('Assistant')}: `);

  const text = await res.text();
  let fullReply = '';

  // Parse SSE events from the response body
  for (const line of text.split('\n')) {
    if (line.startsWith('event: ')) {
      // next line is data
    } else if (line.startsWith('data: ')) {
      const json = JSON.parse(line.slice(6));
      if (line.includes('"text"') && json.text) {
        process.stdout.write(json.text);
        fullReply += json.text;
      }
      if (json.name) {
        // tool call event
        process.stdout.write(`\n  ${c.dim('↪')} ${c.yellow(json.name)}`);
        startSpinner('Fetching data');
      }
      if (json.reply !== undefined) {
        // done event — update history
        history = json.history || [];
        if (!fullReply) process.stdout.write(json.reply);
      }
      if (json.message && !json.reply && !json.text) {
        // error event
        process.stdout.write(c.red(json.message));
      }
    }
  }

  process.stdout.write('\n\n');
}

// ── Direct mode (no server) ─────────────────────────────────────────────────

let anthropic, fliplet, tools, executeTool, appId;

async function initDirect() {
  const Anthropic = require('@anthropic-ai/sdk');
  const FlipletAPI = require('./fliplet-api');
  const { buildTools, executeTool: exec } = require('./tools');

  const missing = ['ANTHROPIC_API_KEY', 'FLIPLET_API_TOKEN', 'FLIPLET_APP_ID']
    .filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(c.red(`Missing env vars: ${missing.join(', ')}`));
    process.exit(1);
  }

  appId = process.env.FLIPLET_APP_ID;
  anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  fliplet = new FlipletAPI(process.env.FLIPLET_API_TOKEN);
  tools = buildTools(appId);
  executeTool = exec;
}

async function chatDirect(message) {
  history.push({ role: 'user', content: message });

  const system = [
    `You are an expert assistant for Fliplet app ${appId}.`,
    'You answer questions about the app\'s data sources, entries, media files, and configuration.',
    'Always call tools to get live data — never guess or fabricate API responses.',
    'When presenting data, use concise tables or bullet lists.',
  ].join(' ');

  for (let round = 0; round < 10; round++) {
    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system,
      tools,
      messages: history.slice(-40),
    });

    // Stream text as it arrives
    let firstText = true;
    stream.on('text', (text) => {
      if (firstText) {
        stopSpinner();
        process.stdout.write(`\n${c.green('Assistant')}: `);
        firstText = false;
      }
      process.stdout.write(text);
    });

    const response = await stream.finalMessage();
    history.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      process.stdout.write('\n\n');
      return;
    }

    if (response.stop_reason === 'tool_use') {
      const results = [];
      for (const block of response.content.filter((b) => b.type === 'tool_use')) {
        stopSpinner();
        process.stdout.write(`\n  ${c.dim('↪')} ${c.yellow(block.name)}`);
        startSpinner('Fetching data');
        try {
          const result = await executeTool(block.name, block.input, fliplet, appId);
          results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
        } catch (err) {
          results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify({ error: err.message }), is_error: true });
        }
      }
      history.push({ role: 'user', content: results });
      startSpinner('Thinking');
    }
  }

  stopSpinner();
  console.log(c.red('\nHit the tool-call limit.\n'));
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const mode = DIRECT ? 'direct' : 'server';

  console.log(`\n  ${c.bold('Fliplet AI Chatbot')}  ${c.dim(`[${mode} mode]`)}`);
  console.log(`  ${c.dim('Ask about data sources, files, app config. Type "exit" to quit.')}\n`);

  if (DIRECT) {
    await initDirect();
    console.log(`  ${c.dim(`App ${appId} · direct Claude connection`)}\n`);
  } else {
    try {
      const res = await fetch(`${SERVER}/health`);
      const data = await res.json();
      console.log(`  ${c.dim(`Connected to ${SERVER} · App ${data.appId}`)}\n`);
    } catch {
      console.error(c.red(`  Cannot reach server at ${SERVER}`));
      console.error(c.dim('  Start it with: npm start'));
      console.error(c.dim('  Or use direct mode: npm run chat:direct\n'));
      process.exit(1);
    }
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const ask = () => {
    rl.question(`${c.cyan('You')}: `, async (input) => {
      const q = input.trim();
      if (!q) return ask();
      if (/^(exit|quit|q)$/i.test(q)) {
        console.log(c.dim('\nBye!\n'));
        process.exit(0);
      }

      startSpinner('Thinking');
      try {
        if (DIRECT) await chatDirect(q);
        else await chatViaServer(q);
      } catch (err) {
        stopSpinner();
        console.error(`\n${c.red('Error')}: ${err.message}\n`);
      }
      ask();
    });
  };

  ask();
}

main();
