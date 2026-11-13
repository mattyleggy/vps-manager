import { h, api, act, button, badge, modal, field, input, select, pageHead, table, load, toast, copyLine } from '../ui.js';

const TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA', 'SSHFP'];
const VALUE_HINT = {
  A: 'An IPv4 address, e.g. 203.0.113.10',
  AAAA: 'An IPv6 address',
  CNAME: 'The hostname this name is an alias of, e.g. example.com',
  MX: 'The mail server hostname, e.g. mail.example.com',
  TXT: 'The text, e.g. v=spf1 include:_spf.example.com ~all (quotes are added for you)',
  NS: 'A nameserver hostname',
  SRV: 'weight port target, e.g. 5 5060 sip.example.com',
  CAA: 'flags tag value, e.g. 0 issue "letsencrypt.org"',
  SSHFP: 'algorithm type fingerprint',
};

// The zone whose records page is showing (null = the list of zones); kept across refreshes of the screen.
let openZone = null;

const fqdn = (name, zone) => (name ? `${name}.${zone}` : zone);

function recordModal(zone, record, ctx) {
  const type = select(TYPES.map((t) => [t, t]), record ? record.type : 'A');
  type.disabled = !!record; // Vultr cannot change a record's type in place
  const name = input({ value: record ? record.name : '', placeholder: 'www   (empty = the domain itself)' });
  const data = input({ value: record ? record.data : '' });
  const ttl = input({ value: String(record ? record.ttl : 300) });
  const priority = input({ value: String(record && record.priority >= 0 ? record.priority : 10) });
  const dataHint = h('div', { class: 'hint' });
  const priorityField = field('Priority', priority);
  const sync = () => {
    dataHint.textContent = VALUE_HINT[type.value] || '';
    priorityField.classList.toggle('hidden', !['MX', 'SRV'].includes(type.value));
  };
  type.addEventListener('change', sync);
  sync();
  modal({
    title: record ? `Edit ${record.type} record in ${zone}` : `Add a record to ${zone}`,
    body: [
      h('div', { class: 'field-row' }, field('Type', type), field('Name', name, `.${zone}`)),
      h('div', { class: 'field' }, h('label', null, 'Value'), data, dataHint),
      h('div', { class: 'field-row' }, field('TTL (seconds)', ttl), priorityField),
    ],
    actions: (close) => [
      button('Cancel', close),
      button(
        record ? 'Save record' : 'Add record',
        async (btn) => {
          const r = await act(btn, () =>
            api('dns:saveRecord', {
              zone,
              id: record ? record.id : undefined,
              type: type.value,
              name: name.value.trim(),
              data: data.value.trim(),
              ttl: Math.trunc(Number(ttl.value)) || 0,
              priority: ['MX', 'SRV'].includes(type.value) ? Math.trunc(Number(priority.value)) || 0 : undefined,
            })
          );
          if (!r) return;
          close();
          toast(r.status === 'already' ? 'That record already exists' : record ? 'Record saved' : 'Record added', 'ok');
          ctx.refresh();
        },
        'primary'
      ),
    ],
  });
}

function addZone(ctx) {
  const zone = input({ placeholder: 'example.com' });
  modal({
    title: 'Add a domain to Vultr DNS',
    body: [field('Domain', zone, 'The registered domain itself, not a subdomain. It starts empty; nothing changes for visitors until its nameservers at the registrar are set to Vultr’s.')],
    actions: (close) => [
      button('Cancel', close),
      button(
        'Add domain',
        async (btn) => {
          const r = await act(btn, () => api('dns:addZone', { zone: zone.value.trim().toLowerCase() }));
          if (!r) return;
          close();
          openZone = r.zone;
          toast(r.existed ? `${r.zone} is already on Vultr DNS` : `${r.zone} added`, 'ok');
          ctx.refresh();
        },
        'primary'
      ),
    ],
  });
}

/** Breadcrumb trail above the page title: every item but the last is a link. */
function crumbs(...items) {
  return h(
    'nav',
    { class: 'crumbs', 'aria-label': 'Breadcrumb' },
    items.map(([label, onClick], i) => [i > 0 && h('span', { class: 'sep' }, '›'), onClick ? h('button', { class: 'crumb', type: 'button', onclick: onClick }, label) : h('span', { class: 'crumb here' }, label)])
  );
}

function open(zone, ctx) {
  openZone = zone;
  ctx.refresh();
}

/** The page for one zone: its records, with the way back in the breadcrumbs. */
function renderZone(zone, root, ctx) {
  root.append(
    crumbs(['DNS', () => open(null, ctx)], [zone]),
    pageHead(
      zone,
      button('Refresh', ctx.refresh),
      button('Point at this server', (b) => act(b, () => pointHere([zone], ctx))),
      button('Add record', () => recordModal(zone, null, ctx), 'primary')
    )
  );
  load(root, async () => {
    const [{ records }, zones] = await Promise.all([api('dns:records', { zone }), api('dns:zones')]);
    const info = zones.zones.find((z) => z.domain === zone);
    const order = (r) => `${String(TYPES.indexOf(r.type)).padStart(2, '0')} ${r.name}`;
    const rows = [...records]
      .sort((a, b) => order(a).localeCompare(order(b)))
      .map((r) =>
        h(
          'tr',
          null,
          h('td', null, badge(r.type, 'info')),
          h('td', { class: 'mono' }, fqdn(r.name, zone)),
          h('td', { class: 'mono' }, ['MX', 'SRV'].includes(r.type) ? `${r.priority} ${r.data}` : r.data),
          h('td', { class: 'muted' }, `${r.ttl}s`),
          h(
            'td',
            { class: 'actions' },
            button('Edit', () => recordModal(zone, r, ctx), 'small'),
            button('Delete', (b) => act(b, () => api('dns:deleteRecord', { zone, id: r.id }), 'Record deleted').then((ok) => ok && ctx.refresh()), 'small danger')
          )
        )
      );
    return [
      info && !info.active && nameserverNote(zones.nameservers, info),
      table(['Type', 'Name', 'Value', 'TTL', ''], rows, 'This zone has no records yet.'),
    ];
  });
}

function nameserverNote(nameservers, zone) {
  return h(
    'div',
    { class: 'warn-box' },
    zone
      ? `These records have no effect yet: ${zone.domain} ${zone.ns.length ? `uses the nameservers ${zone.ns.join(', ')}` : 'has no nameservers that could be looked up'}. Set these two at its registrar:`
      : 'Records only take effect for a domain whose nameservers are Vultr’s. Set these two at the domain’s registrar:',
    nameservers.map((n) => copyLine(n))
  );
}

/** Point hostnames at the server through Vultr DNS and say what happened. Shared with the Domains screen. */
export async function pointHere(domains, ctx) {
  const r = await api('dns:point', { domains });
  const n = (status) => r.results.filter((x) => x.status === status).length;
  const changed = n('created') + n('updated');
  toast(changed ? `${changed} record${changed === 1 ? '' : 's'} now point${changed === 1 ? 's' : ''} at ${r.ip}. It can take a few minutes to be visible.` : `Already pointing at ${r.ip}`, 'ok');
  ctx.refresh();
}

export function render(root, ctx) {
  // Choosing DNS in the sidebar always lands on the list; a refresh stays on the page it was on.
  if (ctx.fromNav) openZone = null;
  if (openZone) return renderZone(openZone, root, ctx);

  root.append(pageHead('DNS', button('Refresh', ctx.refresh), button('Add domain', () => addZone(ctx), 'primary')));
  load(root, async () => {
    const data = await api('dns:zones');
    if (!data.hasKey) {
      return h(
        'div',
        { class: 'card' },
        h('div', { class: 'field muted' }, 'Save a Vultr API key to manage the DNS records of domains hosted on Vultr DNS from here.'),
        button('Open settings', () => ctx.go('settings'), 'primary')
      );
    }
    const rows = data.zones.map((z) =>
      h(
        'tr',
        {
          class: 'clickable',
          tabindex: '0',
          title: `Show the records of ${z.domain}`,
          onclick: () => open(z.domain, ctx),
          onkeydown: (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            open(z.domain, ctx);
          },
        },
        h('td', null, z.domain),
        h(
          'td',
          null,
          z.active ? badge('Live on Vultr', 'ok') : badge(z.ns.length ? 'Nameservers point elsewhere' : 'No nameservers found', 'warn'),
          !z.active && z.ns.length ? h('div', { class: 'muted mono' }, z.ns.join(', ')) : null
        ),
        h('td', { class: 'actions muted' }, '›')
      )
    );
    return [
      table(['Domain', 'Nameservers', ''], rows, 'No domains on Vultr DNS yet. Use “Add domain”.'),
      data.zones.length > 0 && h('div', { class: 'hint muted section' }, 'Click a domain to see and edit its records.'),
      data.zones.some((z) => !z.active) && h('div', { class: 'section' }, nameserverNote(data.nameservers)),
    ];
  });
}
