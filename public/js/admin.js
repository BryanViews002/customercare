(async () => {
  const els = {
    messages: document.getElementById('messages'),
    typing: document.getElementById('typing'),
    form: document.getElementById('composer'),
    input: document.getElementById('input'),
    sendBtn: document.getElementById('send'),
  };

  const list = document.getElementById('conv-list');
  const chat = document.getElementById('chat');
  const noSelection = document.getElementById('no-selection');
  const main = document.getElementById('main');
  const search = document.getElementById('search');
  const statusBtn = document.getElementById('toggle-status');
  const totalUnread = document.getElementById('total-unread');

  const meRes = await fetch('/api/me').then((r) => r.json());
  if (meRes.user?.role !== 'admin') return (window.location.href = '/admin/login');
  const me = meRes.user;
  document.getElementById('who').textContent = `${me.name} · Agent`;

  const socket = io();
  const thread = window.createThread({
    socket,
    me,
    els,
    emptyState: 'No messages in this conversation yet.',
  });

  const state = { rows: [], filter: 'all', query: '', selected: null, online: new Set() };

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

  function rowNode(row) {
    const button = document.createElement('button');
    button.className = 'conv';
    button.dataset.id = row.id;
    if (state.selected === row.id) button.setAttribute('aria-current', 'true');

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = initials(row.user_name);
    const dot = document.createElement('span');
    dot.className = `dot${state.online.has(row.user_id) ? ' on' : ''}`;
    avatar.append(dot);

    const middle = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'conv-name';
    name.textContent = row.user_name;
    const preview = document.createElement('div');
    preview.className = 'conv-preview';
    preview.textContent = row.last_body
      ? `${row.last_role === 'admin' ? 'You: ' : ''}${row.last_body}`
      : 'No messages yet';
    middle.append(name, preview);

    const side = document.createElement('div');
    side.className = 'conv-side';
    const time = document.createElement('div');
    time.className = 'conv-time';
    time.textContent = relative(row.updated_at);
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

  function renderList() {
    list.replaceChildren();
    const rows = state.rows.filter(
      (row) => state.filter === 'all' || row.status === state.filter
    );
    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No conversations here yet.';
      list.append(empty);
    } else {
      for (const row of rows) list.append(rowNode(row));
    }

    const unread = state.rows.reduce((n, row) => n + row.unread, 0);
    totalUnread.hidden = unread === 0;
    totalUnread.textContent = `${unread} unread`;
    document.title = unread ? `(${unread}) Support inbox` : 'Support inbox';
  }

  async function loadList() {
    const params = new URLSearchParams({ status: 'all' });
    if (state.query) params.set('q', state.query);
    const data = await fetch(`/api/admin/conversations?${params}`).then((r) => r.json());
    state.rows = data.conversations ?? [];
    renderList();
  }

  /* -------------------------------------------------------- open thread -- */

  async function open(conversationId) {
    state.selected = conversationId;
    chat.hidden = false;
    noSelection.hidden = true;
    main.classList.add('viewing');

    socket.emit('conversation:join', { conversationId }, (reply) => {
      if (reply?.error) {
        noSelection.textContent = reply.error;
        chat.hidden = true;
        noSelection.hidden = false;
        return;
      }
      thread.load(reply);
      paintHeader(reply.conversation);

      const row = state.rows.find((r) => r.id === conversationId);
      if (row) row.unread = 0;
      renderList();
    });
  }

  function paintHeader(conversation) {
    document.getElementById('customer-name').textContent = conversation.customer.name;
    const bits = [conversation.customer.email || 'Guest visitor'];
    bits.push(conversation.customerOnline ? 'online now' : 'offline');
    if (conversation.status === 'closed') bits.push('resolved');
    document.getElementById('customer-meta').textContent = bits.join(' · ');
    statusBtn.textContent = conversation.status === 'closed' ? 'Reopen' : 'Mark resolved';
    statusBtn.dataset.next = conversation.status === 'closed' ? 'open' : 'closed';
  }

  statusBtn.addEventListener('click', async () => {
    if (!state.selected) return;
    await fetch(`/api/admin/conversations/${state.selected}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: statusBtn.dataset.next }),
    });
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

  /* ------------------------------------------------------ live updates -- */

  socket.on('inbox:update', (row) => {
    if (!row) return;
    const index = state.rows.findIndex((r) => r.id === row.id);
    if (index >= 0) state.rows.splice(index, 1);
    if (row.id === state.selected) row.unread = 0;
    state.rows.unshift(row);
    state.rows.sort((a, b) => b.updated_at - a.updated_at);
    renderList();
  });

  socket.on('presence:user', ({ userId, online }) => {
    if (online) state.online.add(userId);
    else state.online.delete(userId);
    renderList();
    if (state.selected) {
      const row = state.rows.find((r) => r.id === state.selected);
      if (row?.user_id === userId) {
        const meta = document.getElementById('customer-meta').textContent.split(' · ');
        meta[1] = online ? 'online now' : 'offline';
        document.getElementById('customer-meta').textContent = meta.join(' · ');
      }
    }
  });

  socket.on('conversation:updated', (patch) => {
    if (patch.id !== state.selected) return;
    thread.setStatus(patch.status);
    statusBtn.textContent = patch.status === 'closed' ? 'Reopen' : 'Mark resolved';
    statusBtn.dataset.next = patch.status === 'closed' ? 'open' : 'closed';
  });

  socket.on('connect', loadList);

  await loadList();
})();
