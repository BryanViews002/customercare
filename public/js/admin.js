(async () => {
  const els = {
    messages: document.getElementById('messages'),
    typing: document.getElementById('typing'),
    form: document.getElementById('composer'),
    input: document.getElementById('input'),
    sendBtn: document.getElementById('send'),
    attachBtn: document.getElementById('attach'),
    fileInput: document.getElementById('file'),
  };

  const list = document.getElementById('conv-list');
  const chat = document.getElementById('chat');
  const noSelection = document.getElementById('no-selection');
  const main = document.getElementById('main');
  const search = document.getElementById('search');
  const statusBtn = document.getElementById('toggle-status');
  const totalUnread = document.getElementById('total-unread');

  const INBOX_POLL_MS = 4000;
  const INBOX_POLL_MS_IDLE = 20000;

  const meRes = await fetch('/api/me').then((r) => r.json());
  if (meRes.user?.role !== 'admin') return (window.location.href = '/admin/login');
  const me = meRes.user;
  document.getElementById('who').textContent = `${me.name} · Agent`;

  const state = { rows: [], filter: 'all', query: '', selected: null, timer: null };

  const thread = window.createThread({
    me,
    els,
    emptyState: 'No messages in this conversation yet.',
    onUpdate: ({ status, peerOnline }) => {
      if (status) paintStatusButton(status);
      if (peerOnline !== undefined) paintPresence(peerOnline);
    },
  });

  /* ------------------------------------------------------------- inbox -- */

  const initials = (name) =>
    name.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('') || '?';

  const relative = (ts) => {
    const diff = Date.now() - ts;
    if (diff < 60_000) return 'now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
    return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
  };

  function rowNode(row, presenceWindow, serverNow) {
    const button = document.createElement('button');
    button.className = 'conv';
    button.dataset.id = row.id;
    if (state.selected === row.id) button.setAttribute('aria-current', 'true');

    const online = serverNow - Number(row.last_seen_at ?? 0) < presenceWindow;

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = initials(row.user_name);
    const dot = document.createElement('span');
    dot.className = `dot${online ? ' on' : ''}`;
    avatar.append(dot);

    const middle = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'conv-name';
    name.textContent = row.user_name;
    const preview = document.createElement('div');
    preview.className = 'conv-preview';
    // An image-only message stores an empty body, so last_role is what tells
    // us a message exists at all.
    const prefix = row.last_role === 'admin' ? 'You: ' : '';
    preview.textContent = row.last_body
      ? `${prefix}${row.last_body}`
      : row.last_role
        ? `${prefix}📷 Photo`
        : 'No messages yet';
    middle.append(name, preview);

    const side = document.createElement('div');
    side.className = 'conv-side';
    const time = document.createElement('div');
    time.className = 'conv-time';
    time.textContent = relative(Number(row.updated_at));
    side.append(time);

    if (row.unread > 0) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = String(row.unread);
      side.append(badge);
    } else if (row.status === 'closed') {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'Resolved';
      side.append(tag);
    }

    button.append(avatar, middle, side);
    button.addEventListener('click', () => open(row.id));
    return button;
  }

  function renderList(presenceWindow = 20000, serverNow = Date.now()) {
    list.replaceChildren();
    const rows = state.rows.filter((row) => state.filter === 'all' || row.status === state.filter);

    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No conversations here yet.';
      list.append(empty);
    } else {
      for (const row of rows) list.append(rowNode(row, presenceWindow, serverNow));
    }

    const unread = state.rows.reduce((n, row) => n + Number(row.unread), 0);
    totalUnread.hidden = unread === 0;
    totalUnread.textContent = `${unread} unread`;
    document.title = unread ? `(${unread}) Support inbox` : 'Support inbox';
  }

  async function loadList() {
    const params = new URLSearchParams({ status: 'all' });
    if (state.query) params.set('q', state.query);
    try {
      const data = await fetch(`/api/admin/conversations?${params}`).then((r) => r.json());
      if (!data.conversations) return;
      state.rows = data.conversations;
      if (state.selected) {
        const row = state.rows.find((r) => r.id === state.selected);
        if (row) row.unread = 0; // the open thread is being read right now
      }
      renderList(data.presenceWindowMs, data.now);
    } catch {
      /* transient — the next tick retries */
    }
  }

  function scheduleInbox() {
    clearTimeout(state.timer);
    state.timer = setTimeout(async () => {
      await loadList();
      scheduleInbox();
    }, document.hidden ? INBOX_POLL_MS_IDLE : INBOX_POLL_MS);
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) loadList();
    scheduleInbox();
  });

  /* -------------------------------------------------------- open thread -- */

  async function open(conversationId) {
    state.selected = conversationId;
    chat.hidden = false;
    noSelection.hidden = true;
    main.classList.add('viewing');

    try {
      const data = await fetch(`/api/admin/conversations/${conversationId}`).then((r) => r.json());
      if (!data.conversation) throw new Error(data.error || 'Could not open conversation');
      thread.load(data);
      paintHeader(data.conversation);

      const row = state.rows.find((r) => r.id === conversationId);
      if (row) row.unread = 0;
      renderList();
    } catch (err) {
      noSelection.textContent = err.message;
      chat.hidden = true;
      noSelection.hidden = false;
    }
  }

  function paintHeader(conversation) {
    document.getElementById('customer-name').textContent = conversation.customer.name;
    paintPresence(conversation.customerOnline);
    paintStatusButton(conversation.status);
  }

  function paintPresence(online) {
    const meta = document.getElementById('customer-meta');
    const bits = ['Guest visitor', online ? 'online now' : 'offline'];
    if (thread.status === 'closed') bits.push('resolved');
    meta.textContent = bits.join(' · ');
  }

  function paintStatusButton(status) {
    statusBtn.textContent = status === 'closed' ? 'Reopen' : 'Mark resolved';
    statusBtn.dataset.next = status === 'closed' ? 'open' : 'closed';
  }

  statusBtn.addEventListener('click', async () => {
    if (!state.selected) return;
    const data = await fetch(`/api/admin/conversations/${state.selected}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: statusBtn.dataset.next }),
    }).then((r) => r.json());
    if (data.conversation) {
      thread.setStatus(data.conversation.status);
      paintStatusButton(data.conversation.status);
      loadList();
    }
  });

  /* ------------------------------------------------------------ filters -- */

  for (const button of document.querySelectorAll('.filters button')) {
    button.addEventListener('click', () => {
      state.filter = button.dataset.status;
      for (const other of document.querySelectorAll('.filters button')) {
        other.setAttribute('aria-pressed', String(other === button));
      }
      renderList();
    });
  }

  let searchTimer = null;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = search.value.trim();
      loadList();
    }, 220);
  });

  document.getElementById('back').addEventListener('click', () => {
    main.classList.remove('viewing');
  });

  document.getElementById('logout').addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/admin/login';
  });

  await loadList();
  scheduleInbox();
})();
