'use strict';
// Writes an nginx config with Claude and streams it, as it is written, to the config editor.
//
// It only produces text: nothing is written to the server here. The editor shows the result
// and the user saves it like any manual edit, through the same review as everything else.

const MODEL = 'claude-opus-5-5';

const SYSTEM = `You write nginx configuration files for VPS Manager, a desktop app that manages one Ubuntu server. The file you write is one site config from /etc/nginx/sites-available (or /etc/nginx/conf.d); nginx includes it inside its http {} block, so it holds server {} blocks and http-level directives such as upstream, map and limit_req_zone, never http {} or events {}.

Reply with the complete file and nothing else: no markdown code fences, no explanation before or after it. The reply is streamed straight into the user's editor, and they review it before saving.

Rules:
- Change what the request asks for and keep everything else as it is, including comments, ordering and formatting, so the user's diff shows only the real change.
- Keep lines managed by Certbot (marked "# managed by Certbot"), ssl_certificate paths and redirect blocks it created unless the request is about them. Never point ssl_certificate at a file that is not already referenced in the current config.
- Proxied apps run on 127.0.0.1 ports. Forward Host, X-Real-IP, X-Forwarded-For and X-Forwarded-Proto. Use proxy_http_version 1.1 and the Upgrade/Connection headers when WebSockets may be used.
- Write for the nginx version in Ubuntu LTS (1.24): "listen 443 ssl http2" rather than the standalone http2 directive.
- Indent with 4 spaces. A short comment is welcome where a line's purpose is not obvious.
- The result must pass nginx -t. Every directive ends with ";", braces balance, and any variable you use (such as $connection_upgrade) is defined.
- If the request cannot be done in nginx config, return the current file unchanged with a comment at the top explaining why.`;

function userMessage({ path, name, current, instruction, lastError, sites }) {
  const others = (sites || []).filter((s) => s.name !== name);
  return [
    `<file path="${path}">\n${current || '(empty: this is a new file)'}\n</file>`,
    others.length
      ? `<other_sites note="Other configs on this server, for context. Do not reuse their domain names or the ports their apps run on.">\n${others.map((s) => `${s.name}: domains ${s.summary.domains.join(' ') || '(none)'}; serves ${s.summary.targets.join(', ') || '-'}${s.enabled ? '' : ' (disabled)'}`).join('\n')}\n</other_sites>`
      : '',
    lastError ? `<nginx_test_error note="nginx -t rejected the last attempt to save this file">\n${lastError}\n</nginx_test_error>` : '',
    `<request>\n${instruction}\n</request>`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Drop a markdown fence the model may wrap the file in, despite being asked not to. */
function stripFences(text, final) {
  let t = text.replace(/^\s*```[^\n]*\n/, '');
  if (final) t = t.replace(/\n?```\s*$/, '');
  return t;
}

function createNginxAi({ client, describeError, apiKey, emit, listSites }) {
  let current = null; // { id, controller }
  let seq = 0;

  async function run(id, controller, input) {
    let raw = '';
    let sent = 0;
    const flush = (final) => {
      // Until the first line is complete it may still turn out to be a fence.
      if (!final && !raw.includes('\n') && /^\s*`/.test(raw)) return;
      let t = stripFences(raw, final);
      if (!final) {
        // Hold back a last line that might be a closing fence.
        const nl = t.lastIndexOf('\n');
        if (t.slice(nl + 1).startsWith('`')) t = t.slice(0, nl + 1);
      }
      if (t.length > sent) {
        emit({ id, type: 'delta', text: t.slice(sent) });
        sent = t.length;
      }
    };
    try {
      let sites = [];
      try {
        sites = await listSites();
      } catch {
        // context only; generate without it
      }
      const stream = client(apiKey()).beta.messages.stream(
        {
          model: MODEL,
          max_tokens: 32000,
          thinking: { type: 'adaptive' },
          output_config: { effort: 'medium' },
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          cache_control: { type: 'ephemeral' },
          system: SYSTEM,
          messages: [{ role: 'user', content: userMessage({ ...input, sites }) }],
        },
        { signal: controller.signal }
      );
      let thinking = false;
      stream.on('thinking', () => {
        if (thinking) return;
        thinking = true;
        emit({ id, type: 'thinking' });
      });
      stream.on('text', (delta) => {
        raw += delta;
        flush(false);
      });
      const message = await stream.finalMessage();
      if (message.stop_reason === 'refusal') throw new Error('The model declined this request.');
      if (message.stop_reason === 'max_tokens') throw new Error('The config was cut off because it reached the length limit.');
      flush(true);
      const text = `${stripFences(raw, true).replace(/\s+$/, '')}\n`;
      if (!text.trim()) throw new Error('The model returned an empty config.');
      emit({ id, type: 'done', text });
    } catch (err) {
      if (controller.signal.aborted) emit({ id, type: 'stopped' });
      else emit({ id, type: 'error', message: describeError(err, !!apiKey()) });
    } finally {
      if (current && current.id === id) current = null;
    }
  }

  return {
    /** Starts writing; progress arrives as events carrying the returned id. One at a time. */
    generate(input) {
      const instruction = String(input.instruction || '').trim();
      if (!instruction) throw new Error('Describe what the config should do');
      if (current) current.controller.abort();
      const id = ++seq;
      const controller = new AbortController();
      current = { id, controller };
      run(id, controller, {
        name: String(input.name || ''),
        path: String(input.path || ''),
        current: String(input.current || ''),
        instruction,
        lastError: input.lastError ? String(input.lastError).slice(0, 4000) : '',
      });
      return { id };
    },
    stop() {
      if (current) current.controller.abort();
    },
  };
}

module.exports = createNginxAi;
module.exports.stripFences = stripFences;
module.exports.userMessage = userMessage;
module.exports.MODEL = MODEL;
