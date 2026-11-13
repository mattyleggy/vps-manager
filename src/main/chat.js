'use strict';
// The in-app assistant: a Claude tool-use loop whose tools are the app's own actions.
//
// The model can only do what actions.js defines - it has no shell. Every tool call goes
// through runAction(), the same entry point the buttons use, so a change proposed by the
// model stops at the same review gate as one made by hand: the exact commands are shown (in
// the assistant panel, on the step that proposed them) and nothing runs until the user says so.

const AnthropicSdk = require('@anthropic-ai/sdk');
const { validate } = require('./schema');
const { toolName } = require('./actions');

const Anthropic = AnthropicSdk.default || AnthropicSdk;
const MODEL = 'claude-opus-5-5';
const MAX_ROUNDS = 40; // tool-use round trips per user message
const RESULT_LIMIT = 60000; // characters of one tool result sent back to the model

let clientFactory = (apiKey) => new Anthropic(apiKey ? { apiKey } : {});

const systemPrompt = (server) => `You are the assistant built into VPS Manager, a desktop app that manages one Ubuntu server over SSH. You are connected to ${server}. The app covers four areas: nginx sites and their HTTPS certificates, Docker containers and compose projects, push-to-deploy from GitHub through a webhook agent on the server, and DNS records for domains hosted on the user's Vultr account (the dns_ tools; these call the Vultr API rather than the server).

You act only through the tools provided. You have no shell and cannot do anything they don't cover; if the user asks for something outside them, say so plainly and, where useful, tell them the command they could run themselves.

How changes work. Tools described as "CHANGES THE SERVER" do not run when you call them. The app first shows the user a card in this panel with what will happen and the exact commands, and asks whether to run it; nothing runs unless they press Run. That card is the question, so when the user has asked for something, call the tool rather than also asking "shall I go ahead?" in chat. Before every change tool call, say in a sentence or two what you are about to do and why, so the user can decide from your words and the card together. If a tool result says the user chose not to run it, do not call it again; ask what they would like instead.

Look before changing. Names of sites, containers and projects come from the list tools, not from guesses: call nginx_list, docker_list or deploy_status before acting on something you have not seen in this conversation. To edit an nginx config, read it with nginx_read and send the complete new file to nginx_save. For HTTPS, check dns_check first; a certificate request fails if the domain does not point at this server. If it does not and the domain's zone is on Vultr (dns_zones), dns_point can fix that; record ids come from dns_records.

Use judgement about scope. Do what was asked and no more: don't restart, prune or reconfigure things on the side. When a request is ambiguous about which site, container or project is meant, ask. When a tool fails, read the error, explain it in plain words and suggest the next step; don't retry the same call unchanged.

Replies are read in a narrow side panel next to the screen the user is working in. Keep them short and direct: lead with the answer or the outcome, then only the details that matter. The panel renders paragraphs, bullet lists, **bold**, \`inline code\` and fenced code blocks; it does not render tables or headings.`;

function clip(text) {
  if (text.length <= RESULT_LIMIT) return text;
  const head = Math.floor(RESULT_LIMIT / 3);
  const tail = RESULT_LIMIT - head;
  return `${text.slice(0, head)}\n\n[... ${text.length - RESULT_LIMIT} characters omitted from the middle of this output ...]\n\n${text.slice(-tail)}`;
}

function describeError(err, hasSavedKey) {
  if (err instanceof Anthropic.AuthenticationError) return 'Anthropic rejected the API key. Check the key in Settings.';
  if (err instanceof Anthropic.PermissionDeniedError) return `This API key is not allowed to do that: ${err.message}`;
  if (err instanceof Anthropic.RateLimitError) return 'Rate limited by the Anthropic API. Wait a moment and try again.';
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach the Anthropic API. Check your internet connection.';
  if (err instanceof Anthropic.APIError) return `Anthropic API error${err.status ? ` ${err.status}` : ''}: ${err.message}`;
  return hasSavedKey ? err.message : `${err.message}\n\nNo Anthropic API key is saved. Add one in Settings.`;
}

function createChat({ actions, runAction, emit, apiKey, serverLabel }) {
  const byTool = new Map(actions.map((a) => [toolName(a.id), a]));
  // Fixed order and content: the tool list is part of the cached prompt prefix.
  const tools = actions.map((a) => ({
    name: toolName(a.id),
    description: `${a.change ? 'CHANGES THE SERVER (the user reviews the exact commands before anything runs). ' : 'Read-only. '}${a.description}`,
    input_schema: a.input,
    eager_input_streaming: true,
  }));

  let messages = []; // Anthropic message params: the model's view of the conversation
  let controller = null;

  async function runTool(call) {
    const base = { type: 'tool_result', tool_use_id: call.id };
    const action = byTool.get(call.name);
    if (!action) return { ...base, is_error: true, content: `Unknown tool ${call.name}` };
    // Eager input streaming means the API has not validated this input; a truncated or
    // malformed one must never reach the action.
    const problem = validate(action.input, call.input);
    if (problem) return { ...base, is_error: true, content: JSON.stringify({ INVALID_JSON: JSON.stringify(call.input), problem }) };
    if (controller.signal.aborted) return { ...base, is_error: true, content: 'The user pressed Stop before this ran. Nothing was changed.' };

    const ev = { type: 'tool', id: call.id, name: call.name, change: !!action.change, input: call.input };
    emit({ ...ev, status: 'running' });
    try {
      const r = await runAction(action.id, call.input, { chat: call.id });
      if (!r.ok) {
        emit({ ...ev, status: 'declined' });
        return { ...base, is_error: true, content: 'The user was shown the exact commands for this action and chose not to run it. Nothing was changed. Do not retry it; ask what they would like instead.' };
      }
      const shown = action.forModel ? action.forModel(r.data, call.input) : r.data;
      const failed = r.data && typeof r.data.code === 'number' && r.data.code !== 0; // a command that ran and exited non-zero
      emit({ ...ev, status: failed ? 'failed' : 'done' });
      const text = shown === undefined || shown === null ? 'Done.' : typeof shown === 'string' ? shown : JSON.stringify(shown);
      return { ...base, is_error: failed || undefined, content: clip(text) || 'Done (no output).' };
    } catch (e) {
      emit({ ...ev, status: 'failed', error: e.message });
      return { ...base, is_error: true, content: e.message };
    }
  }

  async function send(text) {
    if (controller) throw new Error('The assistant is still working on the previous message');
    if (!text.trim()) return;
    const server = serverLabel();
    if (!server) throw new Error('Connect to the server first');

    controller = new AbortController();
    const key = apiKey();
    // If the turn fails part-way, history is rolled back to the last point where it was
    // complete (every tool_use answered), so the next message starts from a valid state.
    // `log` is this turn's own reference: New chat swaps `messages` for a fresh array, and a
    // turn that is still winding down must not write to (or roll back) the new one.
    const log = messages;
    let safe = log.length;
    log.push({ role: 'user', content: text });
    try {
      const client = clientFactory(key);
      let jsonRetries = 0;
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const stream = client.beta.messages.stream(
          {
            model: MODEL,
            max_tokens: 64000,
            thinking: { type: 'adaptive' },
            output_config: { effort: 'medium' },
            // If the model's safety classifiers decline a request, let the API retry it on its default fallback model.
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
            cache_control: { type: 'ephemeral' },
            system: systemPrompt(server),
            tools,
            messages: log,
          },
          { signal: controller.signal }
        );
        stream.on('text', (delta) => emit({ type: 'text', delta }));

        let message;
        try {
          message = await stream.finalMessage();
          jsonRetries = 0;
        } catch (err) {
          // Only "the tool input was not parseable JSON" is retried; API errors and Stop are not.
          if (err instanceof Anthropic.APIError || controller.signal.aborted || jsonRetries++ >= 2) throw err;
          emit({ type: 'discard' });
          continue;
        }

        if (message.stop_reason === 'refusal') {
          // A refusal can cut a tool call off mid-input: never run that turn's tools.
          emit({ type: 'discard' });
          emit({ type: 'notice', text: 'The model declined this request.' });
          log.length = safe;
          return;
        }
        const calls = message.content.filter((b) => b.type === 'tool_use');
        if (calls.length && message.stop_reason === 'max_tokens') {
          throw new Error('The reply was cut off in the middle of an action, so nothing was run. Try again, or ask for a smaller step.');
        }

        log.push({ role: 'assistant', content: message.content });
        if (message.stop_reason === 'pause_turn') continue;
        if (!calls.length) {
          if (message.stop_reason === 'max_tokens') emit({ type: 'notice', text: 'The reply was cut off because it reached the length limit.' });
          safe = log.length;
          return;
        }

        // One at a time, in order: each change asks its own question. All results go
        // back in a single user message.
        emit({ type: 'break' });
        const results = [];
        for (const call of calls) results.push(await runTool(call));
        log.push({ role: 'user', content: results });
        safe = log.length;
        // Stop pressed while a tool ran or its question was open: don't go back to the model.
        if (controller.signal.aborted) throw new Error('Stopped');
      }
      emit({ type: 'notice', text: `Stopped after ${MAX_ROUNDS} steps. Send another message to continue.` });
    } catch (err) {
      log.length = safe;
      if (controller.signal.aborted) emit({ type: 'notice', text: 'Stopped.' });
      else emit({ type: 'error', text: describeError(err, !!key) });
    } finally {
      controller = null;
      emit({ type: 'done' });
    }
  }

  return {
    send,
    stop() {
      if (controller) controller.abort();
    },
    reset() {
      if (controller) controller.abort();
      messages = [];
    },
    get busy() {
      return !!controller;
    },
    get history() {
      return messages;
    },
    tools,
  };
}

module.exports = createChat;
module.exports.MODEL = MODEL;
/** Tests replace the Anthropic client with a scripted one. */
module.exports.setClientFactory = (fn) => {
  clientFactory = fn;
};
