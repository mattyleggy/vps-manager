// nginx language support for Monaco: syntax colours, completions, hover docs, a formatter and
// a quick lint (braces and missing semicolons). Pure functions are exported for the tests.

// [name, module, contexts, argument snippet, description]
// contexts: m = main, e = events, h = http, s = server, l = location (and if), u = upstream.
// A snippet of null means a block directive (inserted with braces).
const D = [
  // core
  ['user', 'core', 'm', '{{1:www-data}}', 'User (and group) the worker processes run as.'],
  ['worker_processes', 'core', 'm', '{{1:auto}}', 'Number of worker processes; `auto` = one per CPU core.'],
  ['worker_rlimit_nofile', 'core', 'm', '{{1:65535}}', 'Limit on open files for worker processes.'],
  ['pid', 'core', 'm', '{{1:/run/nginx.pid}}', 'File that stores the master process ID.'],
  ['error_log', 'core', 'mhsl', '{{1:/var/log/nginx/error.log}} {{2:warn}}', 'Where errors are logged, and the minimum level (debug, info, notice, warn, error, crit).'],
  ['include', 'core', 'mehslu', '{{1:/etc/nginx/snippets/file.conf}}', 'Includes another file, or files matching a mask, into this place.'],
  ['events', 'core', 'm', null, 'Block for connection processing settings.'],
  ['worker_connections', 'core', 'e', '{{1:768}}', 'Maximum simultaneous connections per worker process.'],
  ['multi_accept', 'core', 'e', '{{1:on}}', 'Accept all new connections at once rather than one at a time.', 1],
  // http core
  ['http', 'http/ngx_http_core_module', 'm', null, 'Block for HTTP server settings.'],
  ['server', 'http/ngx_http_core_module', 'h', null, 'A virtual server: one site, matched by `listen` and `server_name`.'],
  ['listen', 'http/ngx_http_core_module', 's', '{{1:80}}', 'Address and/or port the server accepts requests on. Add `ssl` for HTTPS, `default_server` to make it the fallback.'],
  ['server_name', 'http/ngx_http_core_module', 's', '{{1:example.com www.example.com}}', 'Names (Host headers) this server answers for. Wildcards (`*.example.com`) and regexes (`~^...`) are allowed.'],
  ['root', 'http/ngx_http_core_module', 'hsl', '{{1:/var/www/html}}', 'Folder requests are served from; the URI is appended to it.'],
  ['alias', 'http/ngx_http_core_module', 'l', '{{1:/var/www/files/}}', 'Replaces the matched location prefix with this path (unlike `root`, which appends the whole URI).'],
  ['location', 'http/ngx_http_core_module', 'sl', null, 'Settings for requests whose URI matches. `=` exact, `^~` prefix that skips regexes, `~` / `~*` regex (case-sensitive / insensitive).'],
  ['try_files', 'http/ngx_http_core_module', 'sl', '{{1:\\$uri \\$uri/ =404}}', 'Tries files in order and serves the first that exists; the last argument is a fallback URI or `=code`.'],
  ['error_page', 'http/ngx_http_core_module', 'hsl', '{{1:404}} {{2:/404.html}}', 'URI shown for the given error codes.'],
  ['client_max_body_size', 'http/ngx_http_core_module', 'hsl', '{{1:10m}}', 'Largest allowed request body (uploads). `0` disables the check. Default 1m.'],
  ['client_body_timeout', 'http/ngx_http_core_module', 'hsl', '{{1:60s}}', 'Timeout between two reads of the request body.'],
  ['client_header_timeout', 'http/ngx_http_core_module', 'hs', '{{1:60s}}', 'Timeout for reading the request header.'],
  ['client_body_buffer_size', 'http/ngx_http_core_module', 'hsl', '{{1:16k}}', 'Buffer for reading the request body; larger bodies go to a temp file.'],
  ['large_client_header_buffers', 'http/ngx_http_core_module', 'hs', '{{1:4}} {{2:16k}}', 'Number and size of buffers for large request headers.'],
  ['keepalive_timeout', 'http/ngx_http_core_module', 'hsl', '{{1:65}}', 'How long an idle keep-alive client connection stays open.'],
  ['send_timeout', 'http/ngx_http_core_module', 'hsl', '{{1:60s}}', 'Timeout between two writes to the client.'],
  ['sendfile', 'http/ngx_http_core_module', 'hsl', '{{1:on}}', 'Use the kernel sendfile() for static files.', 1],
  ['tcp_nopush', 'http/ngx_http_core_module', 'hsl', '{{1:on}}', 'Send response headers and the file start in one packet (with sendfile).', 1],
  ['tcp_nodelay', 'http/ngx_http_core_module', 'hsl', '{{1:on}}', 'Disable Nagle’s algorithm on keep-alive connections.', 1],
  ['server_tokens', 'http/ngx_http_core_module', 'hsl', '{{1:off}}', 'Show the nginx version in error pages and the Server header.', 1],
  ['default_type', 'http/ngx_http_core_module', 'hsl', '{{1:application/octet-stream}}', 'MIME type for files whose extension is not in `types`.'],
  ['types', 'http/ngx_http_core_module', 'hsl', null, 'Maps file extensions to MIME types.'],
  ['types_hash_max_size', 'http/ngx_http_core_module', 'hsl', '{{1:2048}}', 'Maximum size of the types hash table.'],
  ['server_names_hash_bucket_size', 'http/ngx_http_core_module', 'h', '{{1:64}}', 'Bucket size for the server names hash; raise it for long domain names.'],
  ['internal', 'http/ngx_http_core_module', 'l', '', 'Location can only be reached by internal redirects, not directly by clients.'],
  ['limit_except', 'http/ngx_http_core_module', 'l', null, 'Restricts HTTP methods other than the ones listed.'],
  ['resolver', 'http/ngx_http_core_module', 'hsl', '{{1:1.1.1.1 8.8.8.8}} valid={{2:300s}}', 'DNS servers used to resolve upstream names at runtime.'],
  ['underscores_in_headers', 'http/ngx_http_core_module', 'hs', '{{1:on}}', 'Allow underscores in client request header names.', 1],
  ['absolute_redirect', 'http/ngx_http_core_module', 'hsl', '{{1:off}}', 'Whether redirects issued by nginx are absolute (with scheme and host).', 1],
  ['port_in_redirect', 'http/ngx_http_core_module', 'hsl', '{{1:off}}', 'Whether the port is included in absolute redirects issued by nginx.', 1],
  ['etag', 'http/ngx_http_core_module', 'hsl', '{{1:on}}', 'Send an ETag header for static files.', 1],
  ['satisfy', 'http/ngx_http_core_module', 'hsl', '{{1:any}}', 'Allow access if all (`all`) or at least one (`any`) of the access/auth modules allow it.'],
  ['open_file_cache', 'http/ngx_http_core_module', 'hsl', 'max={{1:1000}} inactive={{2:20s}}', 'Cache open file descriptors and file lookups.'],
  // index, autoindex, charset
  ['index', 'http/ngx_http_index_module', 'hsl', '{{1:index.html index.htm}}', 'Files tried, in order, when a request ends with `/`.'],
  ['autoindex', 'http/ngx_http_autoindex_module', 'hsl', '{{1:off}}', 'Show a directory listing when there is no index file.', 1],
  ['charset', 'http/ngx_http_charset_module', 'hsl', '{{1:utf-8}}', 'Charset added to the Content-Type header.'],
  // rewrite
  ['return', 'http/ngx_http_rewrite_module', 'sl', '{{1:301}} {{2:https://\\$host\\$request_uri}}', 'Stops processing and returns a status code, optionally with a redirect URL or body text.'],
  ['rewrite', 'http/ngx_http_rewrite_module', 'sl', '{{1:^/old/(.*)\\$}} {{2:/new/\\$1}} {{3:permanent}}', 'Rewrites the URI if it matches the regex. Flags: last, break, redirect (302), permanent (301).'],
  ['if', 'http/ngx_http_rewrite_module', 'sl', null, 'Conditional block. Inside `location`, only `return` and `rewrite ... last` are fully safe (“if is evil”).'],
  ['set', 'http/ngx_http_rewrite_module', 'sl', '\\${{1:var}} {{2:value}}', 'Sets a variable.'],
  ['break', 'http/ngx_http_rewrite_module', 'sl', '', 'Stops processing the current set of rewrite-module directives.'],
  // access, auth
  ['allow', 'http/ngx_http_access_module', 'hsl', '{{1:127.0.0.1}}', 'Allows access from an address or network. Rules are checked in order.'],
  ['deny', 'http/ngx_http_access_module', 'hsl', '{{1:all}}', 'Denies access from an address or network. Rules are checked in order.'],
  ['auth_basic', 'http/ngx_http_auth_basic_module', 'hsl', '"{{1:Restricted}}"', 'Enables HTTP basic auth with this realm name, or `off`.'],
  ['auth_basic_user_file', 'http/ngx_http_auth_basic_module', 'hsl', '{{1:/etc/nginx/.htpasswd}}', 'Password file for basic auth (create with `htpasswd`).'],
  // headers, logs
  ['add_header', 'http/ngx_http_headers_module', 'hsl', '{{1:X-Frame-Options}} "{{2:SAMEORIGIN}}" always', 'Adds a response header. Note: any `add_header` in a block cancels those inherited from outer blocks. `always` adds it to error responses too.'],
  ['expires', 'http/ngx_http_headers_module', 'hsl', '{{1:30d}}', 'Sets Expires and Cache-Control max-age. `off`, `epoch`, `max` or a time.'],
  ['access_log', 'http/ngx_http_log_module', 'hsl', '{{1:/var/log/nginx/access.log}}', 'Where requests are logged (optionally with a log_format name), or `off`.'],
  ['log_format', 'http/ngx_http_log_module', 'h', '{{1:main}} \'{{2:\\$remote_addr - \\$remote_user [\\$time_local] "\\$request" \\$status}}\'', 'Defines a named log format.'],
  // gzip
  ['gzip', 'http/ngx_http_gzip_module', 'hsl', '{{1:on}}', 'Compress responses with gzip.', 1],
  ['gzip_types', 'http/ngx_http_gzip_module', 'hsl', '{{1:text/plain text/css application/json application/javascript text/xml application/xml image/svg+xml}}', 'MIME types to compress in addition to text/html.'],
  ['gzip_comp_level', 'http/ngx_http_gzip_module', 'hsl', '{{1:5}}', 'Compression level 1–9.'],
  ['gzip_min_length', 'http/ngx_http_gzip_module', 'hsl', '{{1:256}}', 'Smallest response (bytes) worth compressing.'],
  ['gzip_vary', 'http/ngx_http_gzip_module', 'hsl', '{{1:on}}', 'Add `Vary: Accept-Encoding`.', 1],
  ['gzip_proxied', 'http/ngx_http_gzip_module', 'hsl', '{{1:any}}', 'Compress responses to proxied requests (any, off, expired, no-cache, ...).'],
  ['gzip_disable', 'http/ngx_http_gzip_module', 'hsl', '"{{1:msie6}}"', 'Do not compress for User-Agents matching these regexes.'],
  // ssl / http2
  ['ssl_certificate', 'http/ngx_http_ssl_module', 'hs', '{{1:/etc/letsencrypt/live/example.com/fullchain.pem}}', 'Certificate file (with the chain) in PEM format.'],
  ['ssl_certificate_key', 'http/ngx_http_ssl_module', 'hs', '{{1:/etc/letsencrypt/live/example.com/privkey.pem}}', 'Private key file for `ssl_certificate`.'],
  ['ssl_protocols', 'http/ngx_http_ssl_module', 'hs', '{{1:TLSv1.2 TLSv1.3}}', 'Enabled TLS versions.'],
  ['ssl_ciphers', 'http/ngx_http_ssl_module', 'hs', '{{1:HIGH:!aNULL:!MD5}}', 'Enabled ciphers, in OpenSSL format.'],
  ['ssl_prefer_server_ciphers', 'http/ngx_http_ssl_module', 'hs', '{{1:off}}', 'Prefer the server’s cipher order over the client’s.', 1],
  ['ssl_session_cache', 'http/ngx_http_ssl_module', 'hs', 'shared:{{1:SSL}}:{{2:10m}}', 'TLS session cache, shared between workers.'],
  ['ssl_session_timeout', 'http/ngx_http_ssl_module', 'hs', '{{1:1d}}', 'How long a TLS session can be reused.'],
  ['ssl_session_tickets', 'http/ngx_http_ssl_module', 'hs', '{{1:off}}', 'Enable TLS session tickets.', 1],
  ['ssl_dhparam', 'http/ngx_http_ssl_module', 'hs', '{{1:/etc/letsencrypt/ssl-dhparams.pem}}', 'DH parameters file for DHE ciphers.'],
  ['ssl_stapling', 'http/ngx_http_ssl_module', 'hs', '{{1:on}}', 'Enable OCSP stapling.', 1],
  ['ssl_stapling_verify', 'http/ngx_http_ssl_module', 'hs', '{{1:on}}', 'Verify OCSP responses.', 1],
  ['ssl_trusted_certificate', 'http/ngx_http_ssl_module', 'hs', '{{1:/etc/letsencrypt/live/example.com/chain.pem}}', 'CA certificates used to verify OCSP responses.'],
  ['http2', 'http/ngx_http_v2_module', 'hs', '{{1:on}}', 'Enable HTTP/2 (nginx 1.25.1+; older versions use `listen 443 ssl http2`).', 1],
  // proxy
  ['proxy_pass', 'http/ngx_http_proxy_module', 'l', 'http://{{1:127.0.0.1:3000}}', 'Forwards requests to an app or upstream. A URI part (even just `/`) replaces the matched location prefix.'],
  ['proxy_set_header', 'http/ngx_http_proxy_module', 'hsl', '{{1:Host}} {{2:\\$host}}', 'Sets a request header sent to the upstream. Setting any in a block cancels those inherited from outer blocks.'],
  ['proxy_http_version', 'http/ngx_http_proxy_module', 'hsl', '{{1:1.1}}', 'HTTP version used to talk to the upstream; 1.1 is needed for keep-alive and WebSockets.'],
  ['proxy_redirect', 'http/ngx_http_proxy_module', 'hsl', '{{1:off}}', 'Rewrites Location/Refresh headers from the upstream.'],
  ['proxy_buffering', 'http/ngx_http_proxy_module', 'hsl', '{{1:on}}', 'Buffer upstream responses. Turn off for streaming / server-sent events.', 1],
  ['proxy_buffer_size', 'http/ngx_http_proxy_module', 'hsl', '{{1:16k}}', 'Buffer for the first part of the upstream response (headers).'],
  ['proxy_buffers', 'http/ngx_http_proxy_module', 'hsl', '{{1:8}} {{2:16k}}', 'Number and size of buffers for one upstream response.'],
  ['proxy_busy_buffers_size', 'http/ngx_http_proxy_module', 'hsl', '{{1:32k}}', 'Limit on buffers busy sending to the client.'],
  ['proxy_connect_timeout', 'http/ngx_http_proxy_module', 'hsl', '{{1:60s}}', 'Timeout for connecting to the upstream.'],
  ['proxy_read_timeout', 'http/ngx_http_proxy_module', 'hsl', '{{1:60s}}', 'Timeout between two reads from the upstream. Raise for long requests or WebSockets.'],
  ['proxy_send_timeout', 'http/ngx_http_proxy_module', 'hsl', '{{1:60s}}', 'Timeout between two writes to the upstream.'],
  ['proxy_request_buffering', 'http/ngx_http_proxy_module', 'hsl', '{{1:off}}', 'Buffer the whole request body before forwarding it.', 1],
  ['proxy_cache', 'http/ngx_http_proxy_module', 'hsl', '{{1:zone_name}}', 'Cache zone to use (defined with proxy_cache_path), or `off`.'],
  ['proxy_cache_path', 'http/ngx_http_proxy_module', 'h', '{{1:/var/cache/nginx}} levels=1:2 keys_zone={{2:cache}}:{{3:10m}} max_size={{4:1g}} inactive={{5:60m}}', 'Defines a cache folder and its shared-memory zone.'],
  ['proxy_cache_valid', 'http/ngx_http_proxy_module', 'hsl', '{{1:200 302}} {{2:10m}}', 'How long to cache responses with these status codes.'],
  ['proxy_cache_bypass', 'http/ngx_http_proxy_module', 'hsl', '{{1:\\$http_upgrade}}', 'Conditions under which the cache is not used for the response.'],
  ['proxy_no_cache', 'http/ngx_http_proxy_module', 'hsl', '{{1:\\$http_pragma}}', 'Conditions under which the response is not saved to the cache.'],
  ['proxy_hide_header', 'http/ngx_http_proxy_module', 'hsl', '{{1:X-Powered-By}}', 'Removes a header from the upstream response.'],
  ['proxy_pass_header', 'http/ngx_http_proxy_module', 'hsl', '{{1:Server}}', 'Passes a header nginx would otherwise hide.'],
  ['proxy_intercept_errors', 'http/ngx_http_proxy_module', 'hsl', '{{1:on}}', 'Let `error_page` handle upstream error responses.', 1],
  ['proxy_next_upstream', 'http/ngx_http_proxy_module', 'hsl', '{{1:error timeout}}', 'When to try the next upstream server.'],
  ['proxy_ssl_server_name', 'http/ngx_http_proxy_module', 'hsl', '{{1:on}}', 'Send SNI when proxying to an HTTPS upstream.', 1],
  ['proxy_max_temp_file_size', 'http/ngx_http_proxy_module', 'hsl', '{{1:0}}', 'Largest temp file for buffered responses; 0 disables temp files.'],
  ['proxy_cookie_path', 'http/ngx_http_proxy_module', 'hsl', '{{1:/}} {{2:/}}', 'Rewrites the path attribute of Set-Cookie headers.'],
  // fastcgi
  ['fastcgi_pass', 'http/ngx_http_fastcgi_module', 'l', 'unix:{{1:/run/php/php8.3-fpm.sock}}', 'Forwards requests to a FastCGI server such as PHP-FPM.'],
  ['fastcgi_param', 'http/ngx_http_fastcgi_module', 'hsl', '{{1:SCRIPT_FILENAME}} {{2:\\$realpath_root\\$fastcgi_script_name}}', 'Sets a parameter passed to the FastCGI server.'],
  ['fastcgi_index', 'http/ngx_http_fastcgi_module', 'hsl', '{{1:index.php}}', 'File name appended to URIs ending with `/`.'],
  ['fastcgi_split_path_info', 'http/ngx_http_fastcgi_module', 'l', '{{1:^(.+\\.php)(/.+)\\$}}', 'Regex that splits the script name and PATH_INFO.'],
  ['fastcgi_read_timeout', 'http/ngx_http_fastcgi_module', 'hsl', '{{1:60s}}', 'Timeout between two reads from the FastCGI server.'],
  ['fastcgi_buffers', 'http/ngx_http_fastcgi_module', 'hsl', '{{1:16}} {{2:16k}}', 'Number and size of buffers for one FastCGI response.'],
  ['fastcgi_buffer_size', 'http/ngx_http_fastcgi_module', 'hsl', '{{1:32k}}', 'Buffer for the first part of the FastCGI response.'],
  ['fastcgi_intercept_errors', 'http/ngx_http_fastcgi_module', 'hsl', '{{1:on}}', 'Let `error_page` handle FastCGI error responses.', 1],
  ['fastcgi_hide_header', 'http/ngx_http_fastcgi_module', 'hsl', '{{1:X-Powered-By}}', 'Removes a header from the FastCGI response.'],
  // upstream
  ['upstream', 'http/ngx_http_upstream_module', 'h', null, 'A named group of backend servers for proxy_pass / fastcgi_pass.'],
  ['keepalive', 'http/ngx_http_upstream_module', 'u', '{{1:32}}', 'Idle keep-alive connections to keep open to the upstream servers, per worker.'],
  ['least_conn', 'http/ngx_http_upstream_module', 'u', '', 'Send each request to the server with the fewest active connections.'],
  ['ip_hash', 'http/ngx_http_upstream_module', 'u', '', 'Send a client’s requests to the same server, based on its IP.'],
  ['zone', 'http/ngx_http_upstream_module', 'u', '{{1:backend}} {{2:64k}}', 'Shared memory zone for the group’s state.'],
  // limits
  ['limit_req_zone', 'http/ngx_http_limit_req_module', 'h', '\\$binary_remote_addr zone={{1:perip}}:{{2:10m}} rate={{3:10r/s}}', 'Defines a request-rate limit zone.'],
  ['limit_req', 'http/ngx_http_limit_req_module', 'hsl', 'zone={{1:perip}} burst={{2:20}} nodelay', 'Applies a request-rate limit zone.'],
  ['limit_req_status', 'http/ngx_http_limit_req_module', 'hsl', '{{1:429}}', 'Status code returned to rate-limited requests.'],
  ['limit_conn_zone', 'http/ngx_http_limit_conn_module', 'h', '\\$binary_remote_addr zone={{1:addr}}:{{2:10m}}', 'Defines a connection-count limit zone.'],
  ['limit_conn', 'http/ngx_http_limit_conn_module', 'hsl', '{{1:addr}} {{2:10}}', 'Maximum connections per key in the zone.'],
  // real ip, map, misc
  ['set_real_ip_from', 'http/ngx_http_realip_module', 'hsl', '{{1:173.245.48.0/20}}', 'Trusted proxy addresses (e.g. Cloudflare) whose header carries the real client IP.'],
  ['real_ip_header', 'http/ngx_http_realip_module', 'hsl', '{{1:CF-Connecting-IP}}', 'Header holding the real client IP.'],
  ['real_ip_recursive', 'http/ngx_http_realip_module', 'hsl', '{{1:on}}', 'Skip trusted addresses when reading the header from the right.', 1],
  ['map', 'http/ngx_http_map_module', 'h', null, 'Defines a variable whose value depends on another one.'],
  ['sub_filter', 'http/ngx_http_sub_module', 'hsl', "'{{1:old}}' '{{2:new}}'", 'Replaces text in responses.'],
  ['sub_filter_once', 'http/ngx_http_sub_module', 'hsl', '{{1:off}}', 'Replace only the first match, or all of them.', 1],
  ['stub_status', 'http/ngx_http_stub_status_module', 'sl', '', 'Basic status page with connection counts.'],
];

const DIRECTIVES = new Map(D.map(([name, mod, ctx, args, doc, flag]) => [name, { name, mod, ctx, args, doc, flag: !!flag, block: args === null }]));
const BLOCKS = ['http', 'server', 'location', 'upstream', 'events', 'if', 'map', 'types', 'geo', 'limit_except', 'split_clients', 'stream', 'mail'];

const VARIABLES = {
  host: 'Host name from the request line or Host header, or the server name.',
  http_host: 'The Host request header, as sent (may include a port).',
  request_uri: 'The full original URI with arguments.',
  uri: 'The current URI, normalized (changes with rewrites and internal redirects).',
  args: 'Query string arguments.',
  query_string: 'Same as $args.',
  is_args: '`?` if the request has arguments, else empty.',
  remote_addr: 'Client IP address.',
  binary_remote_addr: 'Client IP in binary form (compact key for limit zones).',
  proxy_add_x_forwarded_for: 'The X-Forwarded-For header with the client IP appended.',
  scheme: '`http` or `https`.',
  https: '`on` if the connection is HTTPS.',
  server_name: 'Name of the server that accepted the request.',
  server_port: 'Port that accepted the request.',
  request_method: 'GET, POST, ...',
  request: 'Full original request line.',
  request_filename: 'File path for the current request, from root/alias and the URI.',
  document_root: 'root or alias value for the current request.',
  realpath_root: 'document_root with symlinks resolved.',
  fastcgi_script_name: 'Script name from the URI (with fastcgi_index appended to `/`).',
  fastcgi_path_info: 'PATH_INFO from fastcgi_split_path_info.',
  http_upgrade: 'The Upgrade request header (set for WebSockets).',
  connection_upgrade: 'Commonly defined with a `map` from $http_upgrade, for WebSocket proxying.',
  http_user_agent: 'The User-Agent request header.',
  http_referer: 'The Referer request header.',
  http_cookie: 'The Cookie request header.',
  status: 'Response status code.',
  body_bytes_sent: 'Bytes of response body sent.',
  request_time: 'Request processing time in seconds.',
  upstream_response_time: 'Time spent waiting for the upstream.',
  upstream_addr: 'Address of the upstream that served the request.',
  time_local: 'Local time in Common Log Format.',
  time_iso8601: 'Local time in ISO 8601.',
  remote_user: 'User name from basic auth.',
  content_type: 'Content-Type request header.',
  content_length: 'Content-Length request header.',
  request_body: 'Request body (when read into a buffer).',
  ssl_protocol: 'TLS protocol of the connection.',
};

export function docUrl(d) {
  return d.mod === 'core' ? `https://nginx.org/en/docs/ngx_core_module.html#${d.name}` : `https://nginx.org/en/docs/${d.mod}.html#${d.name}`;
}

// ------------------------------------------------------------------ text scanning helpers

/** One line with the contents of strings and comments blanked (same length, so columns still line up). */
export function codeOnly(line) {
  let out = '';
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\') {
        out += '  ';
        i++;
        continue;
      }
      if (c === quote) {
        quote = null;
        out += c;
      } else out += ' ';
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      continue;
    }
    if (c === '#') return out + ' '.repeat(line.length - i);
    out += c;
  }
  return out;
}

/** Re-indent a config by brace depth: 4 spaces per level, continuation lines one extra level. */
export function formatNginx(text, indent = '    ') {
  const out = [];
  let depth = 0;
  let pending = false; // a directive started on an earlier line hasn't ended yet
  let blank = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      if (out.length && ++blank === 1) out.push('');
      continue;
    }
    blank = 0;
    const code = codeOnly(line).trim();
    const lead = /^}+/.exec(code.replace(/\s/g, ''));
    const closesFirst = code.startsWith('}') ? lead[0].length : 0;
    const level = Math.max(0, depth - closesFirst) + (pending && !closesFirst ? 1 : 0);
    out.push(indent.repeat(level) + line);
    for (const c of code) {
      if (c === '{') depth++;
      else if (c === '}') depth = Math.max(0, depth - 1);
    }
    if (code) pending = !/[;{}]$/.test(code);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return `${out.join('\n')}\n`;
}

/**
 * Quick checks that catch the usual typos before nginx -t does. Returns
 * [{ line, col, endLine, endCol, message, severity: 'error' | 'warning' }] with 1-based positions.
 */
export function lintNginx(text) {
  const lines = text.split(/\r?\n/);
  const problems = [];
  const stack = [];
  let stmt = null; // { first, line, col, endLine, endCol } of the directive not yet ended by ; or {
  const end = (s) => ({ endLine: s.endLine, endCol: s.endCol });
  lines.forEach((raw, i) => {
    const ln = i + 1;
    const code = codeOnly(raw);
    // A known directive at the start of a line while the previous one (also a known
    // directive, not a block) still has no ';' - almost always a forgotten semicolon.
    const firstWord = /^\s*([a-z_][a-z0-9_]*)/i.exec(code);
    if (stmt && firstWord && DIRECTIVES.has(firstWord[1]) && DIRECTIVES.has(stmt.first) && !BLOCKS.includes(stmt.first)) {
      problems.push({ line: stmt.endLine, col: stmt.endCol, ...end(stmt), endCol: stmt.endCol + 1, message: `Missing ';' after this ${stmt.first} directive?`, severity: 'warning' });
      stmt = null;
    }
    const re = /[{};]|[^\s{};]+/g;
    let m;
    while ((m = re.exec(code))) {
      const col = m.index + 1;
      const tok = m[0];
      if (tok === ';') {
        stmt = null;
      } else if (tok === '{') {
        stack.push({ line: ln, col, name: stmt ? stmt.first : '' });
        stmt = null;
      } else if (tok === '}') {
        if (stmt) {
          problems.push({ line: stmt.line, col: stmt.col, ...end(stmt), message: `Missing ';' at the end of this ${stmt.first} directive`, severity: 'error' });
          stmt = null;
        }
        if (!stack.length) problems.push({ line: ln, col, endLine: ln, endCol: col + 1, message: "Unexpected '}' (nothing to close)", severity: 'error' });
        else stack.pop();
      } else {
        // A word: quoted strings were blanked to "   ", so take the original text's extent.
        if (!stmt) stmt = { first: tok.replace(/^["']|["']$/g, ''), line: ln, col };
        stmt.endLine = ln;
        stmt.endCol = col + tok.length;
      }
    }
  });
  if (stmt) problems.push({ line: stmt.line, col: stmt.col, ...end(stmt), message: `Missing ';' at the end of this ${stmt.first} directive`, severity: 'error' });
  for (const open of stack) problems.push({ line: open.line, col: open.col, endLine: open.line, endCol: open.col + 1, message: `This '{'${open.name ? ` (${open.name})` : ''} is never closed`, severity: 'error' });
  return problems;
}

/**
 * Lines of `nginx -t` output that point into this file, e.g.
 * `nginx: [emerg] unknown directive "foo" in /etc/nginx/sites-enabled/example.com:12`.
 */
export function nginxErrors(output, paths) {
  const found = [];
  for (const line of String(output || '').split('\n')) {
    const m = /\[(emerg|alert|crit|error|warn)\]\s*(.*?)\s+in\s+(\S+):(\d+)\s*$/.exec(line);
    if (m && paths.includes(m[3])) found.push({ line: Number(m[4]), message: m[2], severity: m[1] === 'warn' ? 'warning' : 'error' });
  }
  return found;
}

/** Names of the blocks enclosing `offset` (outermost first). */
export function blocksAt(text, offset) {
  const stack = [];
  let words = [];
  const lines = text.slice(0, offset).split('\n');
  for (const raw of lines) {
    const re = /[{};]|[^\s{};]+/g;
    const code = codeOnly(raw);
    let m;
    while ((m = re.exec(code))) {
      if (m[0] === ';') words = [];
      else if (m[0] === '{') {
        stack.push(words[0] || '');
        words = [];
      } else if (m[0] === '}') {
        stack.pop();
        words = [];
      } else words.push(m[0]);
    }
  }
  return stack;
}

// A site file is included inside http {}, so its top level is the http context.
const CTX = { http: 'h', server: 's', location: 'l', if: 'l', limit_except: 'l', upstream: 'u', events: 'e' };
function contextOf(stack) {
  if (!stack.length) return 'h';
  return CTX[stack[stack.length - 1]] || null; // map, types, geo ... take free-form entries
}

// ------------------------------------------------------------------ snippets

/** Snippet text: `$` is literal, {{1:text}} / {{0}} are tab stops. */
const snip = (s) => s.replace(/\$/g, '\\$').replace(/\{\{(\d+)(?::([^}]*))?\}\}/g, (_, n, t) => (t == null ? `$${n}` : `\${${n}:${t}}`));
// Directive argument templates are already written with \\$ escapes.
const argSnip = (s) => s.replace(/\{\{(\d+)(?::([^}]*))?\}\}/g, (_, n, t) => (t == null ? `$${n}` : `\${${n}:${t}}`));

const PROXY_HEADERS = `proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;`;

const SNIPPETS = [
  {
    label: 'server: reverse proxy',
    ctx: 'h',
    doc: 'A site that forwards everything to an app on a local port.',
    body: `server {
    listen 80;
    listen [::]:80;
    server_name {{1:example.com}};

    location / {
        proxy_pass http://127.0.0.1:{{2:3000}};
        ${PROXY_HEADERS.replace(/\n {4}/g, '\n        ')}
    }
}`,
  },
  {
    label: 'server: static site',
    ctx: 'h',
    doc: 'A site served from a folder.',
    body: `server {
    listen 80;
    listen [::]:80;
    server_name {{1:example.com}};
    root {{2:/var/www/example.com}};
    index index.html;

    location / {
        try_files $uri $uri/ =404;
    }
}`,
  },
  {
    label: 'server: redirect HTTP to HTTPS',
    ctx: 'h',
    doc: 'Answers on port 80 and redirects every request to HTTPS.',
    body: `server {
    listen 80;
    listen [::]:80;
    server_name {{1:example.com}};
    return 301 https://$host$request_uri;
}`,
  },
  {
    label: 'location: proxy with WebSockets',
    ctx: 'sl',
    doc: 'Forwards to an app and lets WebSocket connections upgrade.',
    body: `location {{1:/}} {
    proxy_pass http://127.0.0.1:{{2:3000}};
    ${PROXY_HEADERS}
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
}`,
  },
  {
    label: 'location: cache static assets',
    ctx: 'sl',
    doc: 'Long browser caching for images, fonts, CSS and JS.',
    body: `location ~* \\.(?:css|js|mjs|png|jpe?g|gif|webp|avif|svg|ico|woff2?)$ {
    expires {{1:30d}};
    add_header Cache-Control "public, immutable";
    access_log off;
}`,
  },
  {
    label: 'gzip: compress text responses',
    ctx: 'hsl',
    doc: 'Common gzip settings.',
    body: `gzip on;
gzip_vary on;
gzip_proxied any;
gzip_comp_level 5;
gzip_min_length 256;
gzip_types text/plain text/css application/json application/javascript text/xml application/xml image/svg+xml;`,
  },
  {
    label: 'headers: security headers',
    ctx: 'hsl',
    doc: 'A sensible baseline of security headers.',
    body: `add_header X-Frame-Options "SAMEORIGIN" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Strict-Transport-Security "max-age={{1:31536000}}; includeSubDomains" always;`,
  },
  {
    label: 'upstream: backend group',
    ctx: 'h',
    doc: 'A named group of app servers to proxy_pass to.',
    body: `upstream {{1:app}} {
    server 127.0.0.1:{{2:3000}};
    keepalive 32;
}`,
  },
];

// ------------------------------------------------------------------ Monaco registration

let registered = false;

export function registerNginx(monaco) {
  if (registered) return;
  registered = true;
  const { languages } = monaco;
  languages.register({ id: 'nginx', extensions: ['.conf'], aliases: ['nginx', 'Nginx'] });

  languages.setLanguageConfiguration('nginx', {
    comments: { lineComment: '#' },
    brackets: [
      ['{', '}'],
      ['(', ')'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '(', close: ')' },
      { open: '"', close: '"', notIn: ['string', 'comment'] },
      { open: "'", close: "'", notIn: ['string', 'comment'] },
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
    wordPattern: /\$?[A-Za-z_][\w-]*|[^\s;{}()"'#]+/,
    indentationRules: { increaseIndentPattern: /\{[^}"']*(#.*)?$/, decreaseIndentPattern: /^\s*\}/ },
  });

  languages.setMonarchTokensProvider('nginx', {
    defaultToken: '',
    blocks: BLOCKS,
    directives: [...DIRECTIVES.keys()],
    flags: ['on', 'off', 'default_server', 'ssl', 'http2', 'quic', 'reuseport', 'permanent', 'redirect', 'last', 'break', 'always', 'nodelay', 'backup', 'down', 'default', 'any', 'all', 'internal'],
    tokenizer: {
      root: [
        { include: '@ws' },
        [/[{}]/, '@brackets'],
        [/;/, 'delimiter'],
        [/[A-Za-z_][\w.-]*/, { cases: { '@blocks': { token: 'keyword', next: '@args' }, '@directives': { token: 'type', next: '@args' }, '@default': { token: 'type.unknown', next: '@args' } } }],
        [/\S+/, { token: 'identifier', next: '@args' }],
      ],
      args: [
        { include: '@ws' },
        [/;/, { token: 'delimiter', next: '@pop' }],
        [/\{/, { token: '@brackets', next: '@pop' }],
        [/\}/, { token: '@brackets', next: '@pop' }],
        [/"/, { token: 'string.quote', next: '@dstring' }],
        [/'/, { token: 'string.quote', next: '@sstring' }],
        [/\$\{?\w+\}?/, 'variable'],
        [/(\^~|~\*|!~\*|!~|~|=)(?=\s)/, 'operator'],
        [/https?:\/\/[^\s;{}"'$#]+/, 'string.link'],
        [/unix:[^\s;{}]+/, 'string.link'],
        [/\[?[0-9a-fA-F:]*:[0-9a-fA-F:]+\]?(:\d+)?(?=[\s;])/, 'number'],
        [/\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/\d+)?/, 'number'],
        [/\d+(\.\d+)?(ms|[kKmMgGsSdhwy])?(?=[\s;}])/, 'number'],
        [/[A-Za-z_][\w-]*(?==)/, 'attribute.name'],
        [/[A-Za-z_][\w-]*/, { cases: { '@flags': 'keyword.flag', '@default': 'identifier' } }],
        [/[()]/, '@brackets'],
        [/[^\s;{}"'$#()]+/, 'identifier'],
      ],
      dstring: [
        [/\$\{?\w+\}?/, 'variable'],
        [/\\./, 'string.escape'],
        [/[^"\\$]+/, 'string'],
        [/\$/, 'string'],
        [/"/, { token: 'string.quote', next: '@pop' }],
      ],
      sstring: [
        [/\$\{?\w+\}?/, 'variable'],
        [/\\./, 'string.escape'],
        [/[^'\\$]+/, 'string'],
        [/\$/, 'string'],
        [/'/, { token: 'string.quote', next: '@pop' }],
      ],
      ws: [
        [/\s+/, ''],
        [/#.*$/, 'comment'],
      ],
    },
  });

  const md = (d) => `**${d.name}**${d.block ? ' { … }' : ''}\n\n${d.doc}\n\n[nginx docs](${docUrl(d)})`;
  const K = languages.CompletionItemKind;

  languages.registerCompletionItemProvider('nginx', {
    triggerCharacters: ['$'],
    provideCompletionItems(model, position) {
      const text = model.getValue();
      const offset = model.getOffsetAt(position);
      const before = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      const word = model.getWordUntilPosition(position);
      const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };

      // $variables anywhere in arguments
      const v = /\$\{?(\w*)$/.exec(before);
      if (v) {
        const r = { ...range, startColumn: position.column - v[0].length };
        return {
          suggestions: Object.entries(VARIABLES).map(([name, doc]) => ({ label: `$${name}`, kind: K.Variable, insertText: `$${name}`, documentation: doc, range: r })),
        };
      }

      const ctx = contextOf(blocksAt(text, offset));
      if (/^\s*[A-Za-z_]*$/.test(before)) {
        // Directive position: what fits in this block, plus the block templates.
        if (!ctx) return { suggestions: [] };
        const suggestions = [];
        const inUpstream = ctx === 'u';
        for (const d of DIRECTIVES.values()) {
          if (!d.ctx.includes(ctx)) continue;
          const insertText = d.block
            ? d.name === 'location'
              ? 'location ${1:/} {\n\t$0\n}'
              : d.name === 'if'
                ? 'if (${1:\\$http_x} ${2:=} ${3:value}) {\n\t$0\n}'
                : d.name === 'map'
                  ? 'map ${1:\\$http_upgrade} ${2:\\$connection_upgrade} {\n\tdefault ${3:upgrade};\n\t\'\' ${4:close};\n}'
                  : `${d.name} {\n\t$0\n}`
            : `${d.name}${d.args ? ` ${argSnip(d.args)}` : ''};`;
          suggestions.push({ label: d.name, kind: d.block ? K.Module : K.Property, detail: d.mod.replace(/^http\//, ''), documentation: { value: md(d) }, insertText, insertTextRules: 4, range });
        }
        if (inUpstream) {
          suggestions.push({ label: 'server', kind: K.Property, detail: 'upstream server', documentation: 'A backend server in this group.', insertText: 'server ${1:127.0.0.1:3000};', insertTextRules: 4, range });
        }
        for (const s of SNIPPETS) {
          if (!s.ctx.includes(ctx)) continue;
          suggestions.push({ label: s.label, kind: K.Snippet, detail: 'template', documentation: s.doc, insertText: snip(s.body), insertTextRules: 4, range, sortText: `~${s.label}` });
        }
        return { suggestions };
      }

      // Argument position of an on/off directive.
      const name = /^\s*([a-z_0-9]+)\s/.exec(before);
      const d = name && DIRECTIVES.get(name[1]);
      if (d && d.flag) {
        return { suggestions: ['on', 'off'].map((x) => ({ label: x, kind: K.Value, insertText: `${x};`, range })) };
      }
      return { suggestions: [] };
    },
  });

  languages.registerHoverProvider('nginx', {
    provideHover(model, position) {
      const w = model.getWordAtPosition(position);
      if (!w) return null;
      const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: w.startColumn, endColumn: w.endColumn };
      if (w.word.startsWith('$')) {
        const name = w.word.slice(1);
        const doc = VARIABLES[name] || (/^http_/.test(name) ? `The ${name.slice(5).replace(/_/g, '-')} request header.` : /^arg_/.test(name) ? `The “${name.slice(4)}” query argument.` : /^cookie_/.test(name) ? `The “${name.slice(7)}” cookie.` : null);
        return doc ? { range, contents: [{ value: `**$${name}**\n\n${doc}` }] } : null;
      }
      const d = DIRECTIVES.get(w.word);
      // Only the directive name position, not the same word used as an argument.
      const before = model.getLineContent(position.lineNumber).slice(0, w.startColumn - 1);
      if (!d || !/^\s*$/.test(codeOnly(before).replace(/.*[;{}]/, ''))) return null;
      return { range, contents: [{ value: md(d) }, { value: `Allowed in: ${[...d.ctx].map((c) => ({ m: 'main', e: 'events', h: 'http', s: 'server', l: 'location', u: 'upstream' })[c]).join(', ')}` }] };
    },
  });

  languages.registerDocumentFormattingEditProvider('nginx', {
    provideDocumentFormattingEdits(model) {
      return [{ range: model.getFullModelRange(), text: formatNginx(model.getValue()) }];
    },
  });

  monaco.editor.defineTheme('vpsm-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '6b7189', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'b79cff', fontStyle: 'bold' },
      { token: 'keyword.flag', foreground: 'f0abfc' },
      { token: 'type', foreground: '7dd3fc' },
      { token: 'type.unknown', foreground: '93c5fd' },
      { token: 'variable', foreground: 'fbbf24' },
      { token: 'string', foreground: '86efac' },
      { token: 'string.quote', foreground: '86efac' },
      { token: 'string.escape', foreground: 'fde68a' },
      { token: 'string.link', foreground: '5eead4' },
      { token: 'number', foreground: 'f9a8d4' },
      { token: 'operator', foreground: 'fca5a5' },
      { token: 'attribute.name', foreground: 'c4b5fd' },
      { token: 'delimiter', foreground: '8a91a8' },
      { token: 'identifier', foreground: 'dfe3f0' },
    ],
    colors: {
      'editor.background': '#090a0f',
      'editor.foreground': '#dfe3f0',
      'editorLineNumber.foreground': '#3d4256',
      'editorLineNumber.activeForeground': '#9aa1b9',
      'editor.lineHighlightBackground': '#ffffff08',
      'editor.lineHighlightBorder': '#00000000',
      'editor.selectionBackground': '#7c6cff40',
      'editor.inactiveSelectionBackground': '#7c6cff22',
      'editorCursor.foreground': '#a99dff',
      'editorIndentGuide.background1': '#ffffff0d',
      'editorIndentGuide.activeBackground1': '#ffffff26',
      'editorWidget.background': '#12141c',
      'editorWidget.border': '#ffffff1a',
      'editorSuggestWidget.background': '#12141c',
      'editorSuggestWidget.selectedBackground': '#7c6cff33',
      'editorHoverWidget.background': '#12141c',
      'editorGutter.background': '#090a0f',
      'scrollbarSlider.background': '#ffffff14',
      'scrollbarSlider.hoverBackground': '#ffffff24',
      'diffEditor.insertedTextBackground': '#34d39926',
      'diffEditor.removedTextBackground': '#f8717126',
      'diffEditor.insertedLineBackground': '#34d39914',
      'diffEditor.removedLineBackground': '#f8717114',
      focusBorder: '#7c6cff80',
    },
  });
}
