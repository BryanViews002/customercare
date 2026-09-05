/**
 * Shared conversation view used by both the customer page and the agent
 * console. Renders history, polls for new messages, and owns the composer.
 * All message text is written with textContent — never innerHTML.
 *
 * There is no WebSocket: serverless can't hold one open, so the thread asks
 * /poll for anything newer than the last message it holds. The loop sleeps
 * while the tab is hidden and wakes immediately on focus.
 */
const POLL_MS = 2500;
const POLL_MS_IDLE = 15000;

window.createThread = function createThread({ me, els, emptyState, onUpdate }) {
  const state = {
    conversationId: null,
    status: 'open',
    messages: [],
    lastTs: 0,
    loadingMore: false,
    exhausted: false,
    peerReadAt: 0,
    typingTimer: null,
    typingSent: false,
    timer: null,
    failures: 0,
  };

  const fmtTime = (ts) =>
    new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  const fmtDay = (ts) => {
    const d = new Date(ts);
    const today = new Date();
    const yesterday = new Date(Date.now() - 86_400_000);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  };

  const nearBottom = () =>
    els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 120;

  const scrollToBottom = () => {
    els.messages.scrollTop = els.messages.scrollHeight;
  };

  const api = (path, init) =>
    fetch(path, {
      ...init,
      headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}) },
    }).then(async (res) => {
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
      return body;
    });

  /* ------------------------------------------------------------ render -- */

  function messageNode(message, previous) {
    const wrap = document.createElement('div');
    const isMine = message.senderId === me.id;
    wrap.className = `msg ${isMine ? 'out' : 'in'}`;
    wrap.dataset.id = message.id;

    const newGroup =
      !previous ||
      previous.senderId !== message.senderId ||
      message.createdAt - previous.createdAt > 5 * 60_000;
    if (newGroup) {
      wrap.classList.add('start');
      if (!isMine) {
        const who = document.createElement('div');
        who.className = 'who-line';
        who.textContent =
          message.senderRole === 'admin' ? `${message.senderName} · Support` : message.senderName;
        wrap.append(who);
      }
    }

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = message.body;
    wrap.append(bubble);

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = fmtTime(message.createdAt);
    wrap.append(meta);

    return wrap;
  }

  function render() {
    els.messages.replaceChildren();

    if (state.messages.length === 0) {
      // emptyState may be a plain string or a builder returning a node.
      let node;
      if (typeof emptyState === 'function') {
        node = emptyState();
      } else {
        node = document.createElement('div');
        node.className = 'empty';
        node.textContent = emptyState;
      }
      node.classList.add('empty-state');
      els.messages.append(node);
      return;
    }

    let lastDay = '';
    let previous = null;
    for (const message of state.messages) {
      const day = fmtDay(message.createdAt);
      if (day !== lastDay) {
        const sep = document.createElement('div');
        sep.className = 'day-sep';
        sep.textContent = day;
        els.messages.append(sep);
        lastDay = day;
        previous = null;
      }
      els.messages.append(messageNode(message, previous));
      previous = message;
    }
    renderReceipt();
  }

  /** "Seen" marker under the last outgoing message, if the peer has read it. */
  function renderReceipt() {
    els.messages.querySelector('.receipt')?.remove();
    const mine = [...state.messages].reverse().find((m) => m.senderId === me.id);
    if (!mine || state.peerReadAt < mine.createdAt) return;
    const node = els.messages.querySelector(`[data-id="${CSS.escape(mine.id)}"]`);
    if (!node) return;
    const tag = document.createElement('div');
    tag.className = 'meta receipt';
    tag.textContent = 'Seen';
    node.append(tag);
  }

  function absorb(list) {
    let added = false;
    for (const message of list) {
      if (state.messages.some((m) => m.id === message.id)) continue;
      state.messages.push(message);
      state.lastTs = Math.max(state.lastTs, message.createdAt);
      added = true;
    }
    if (added) state.messages.sort((a, b) => a.createdAt - b.createdAt);
    return added;
  }

  /* ------------------------------------------------------------ polling -- */

  async function poll() {
    if (!state.conversationId) return;
    try {
      const data = await api(
        `/api/conversations/${state.conversationId}/poll?after=${state.lastTs}`
      );
      state.failures = 0;

      const stick = nearBottom();
      const grew = absorb(data.messages ?? []);
      state.peerReadAt = data.peerReadAt ?? 0;

      if (grew) {
        render();
        if (stick) scrollToBottom();
      } else {
        renderReceipt();
      }

      els.typing.textContent = data.peerTyping ? 'typing…' : '';

      if (data.status !== state.status) {
        state.status = data.status;
        onUpdate?.({ status: data.status, peerOnline: data.peerOnline });
      } else {
        onUpdate?.({ peerOnline: data.peerOnline });
      }
    } catch {
      state.failures += 1; // back off below after repeated failures
    }
  }

  function schedule() {
    clearTimeout(state.timer);
    if (!state.conversationId) return;
    const base = document.hidden ? POLL_MS_IDLE : POLL_MS;
    const delay = Math.min(base * (1 + Math.min(state.failures, 4)), 30_000);
    state.timer = setTimeout(async () => {
      await poll();
      schedule();
    }, delay);
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.conversationId) {
      poll().then(schedule);
    } else {
      schedule();
    }
  });

  /* ------------------------------------------------------------ sending -- */

  function optimistic(body) {
    const wrap = document.createElement('div');
    wrap.className = 'msg out pending start';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = body;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = 'Sending…';
    wrap.append(bubble, meta);
    els.messages.querySelector('.empty-state')?.remove();
    els.messages.append(wrap);
    scrollToBottom();
    return wrap;
  }

  /** Sends `text`, or whatever is in the composer when called with nothing. */
  async function send(text) {
    const body = (text ?? els.input.value).trim();
    if (!body || !state.conversationId || els.input.disabled) return;

    els.input.value = '';
    els.input.style.height = 'auto';
    stopTyping();
    const node = optimistic(body);

    try {
      const data = await api(`/api/conversations/${state.conversationId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      });
      node.remove();
      absorb([data.message]);
      render();
      scrollToBottom();
    } catch (err) {
      node.classList.remove('pending');
      node.classList.add('failed');
      node.querySelector('.meta').textContent = err.message;
    }
  }

  /* ------------------------------------------------------------- typing -- */

  function pushTyping(isTyping) {
    if (!state.conversationId) return;
    fetch(`/api/conversations/${state.conversationId}/typing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isTyping }),
    }).catch(() => {});
  }

  function stopTyping() {
    clearTimeout(state.typingTimer);
    if (state.typingSent) {
      pushTyping(false);
      state.typingSent = false;
    }
  }

  function noteTyping() {
    if (!state.typingSent) {
      pushTyping(true);
      state.typingSent = true;
    }
    clearTimeout(state.typingTimer);
    state.typingTimer = setTimeout(stopTyping, 2500);
  }

  /* ------------------------------------------------------ older history -- */

  async function loadOlder() {
    if (state.loadingMore || state.exhausted || state.messages.length === 0) return;
    state.loadingMore = true;
    const before = state.messages[0].id;
    const previousHeight = els.messages.scrollHeight;

    try {
      const data = await api(
        `/api/conversations/${state.conversationId}/messages?before=${before}`
      );
      if (!data.messages?.length) {
        state.exhausted = true;
        return;
      }
      state.messages = [...data.messages, ...state.messages];
      render();
      els.messages.scrollTop = els.messages.scrollHeight - previousHeight;
    } catch {
      state.exhausted = true;
    } finally {
      state.loadingMore = false;
    }
  }

  /* --------------------------------------------------------- composer UI -- */

  function setComposerEnabled(enabled, reason) {
    els.input.disabled = !enabled;
    els.sendBtn.disabled = !enabled;
    els.input.placeholder = enabled ? 'Write a message…' : reason || 'Conversation closed';
  }

  els.form.addEventListener('submit', (event) => {
    event.preventDefault();
    send();
  });

  els.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });

  els.input.addEventListener('input', () => {
    els.input.style.height = 'auto';
    els.input.style.height = `${Math.min(els.input.scrollHeight, 160)}px`;
    noteTyping();
  });

  els.messages.addEventListener('scroll', () => {
    if (els.messages.scrollTop < 60) loadOlder();
  });

  return {
    get conversationId() {
      return state.conversationId;
    },
    get status() {
      return state.status;
    },
    /** Swap the view to a conversation and paint its history. */
    load({ conversation, messages: history }) {
      state.conversationId = conversation.id;
      state.status = conversation.status;
      state.messages = history;
      state.lastTs = history.reduce((max, m) => Math.max(max, m.createdAt), 0);
      state.exhausted = history.length < 50;
      state.peerReadAt = 0;
      state.failures = 0;
      els.typing.textContent = '';
      render();
      scrollToBottom();
      schedule();
    },
    sendText: (text) => send(text),
    setStatus(status) {
      state.status = status;
    },
    setComposerEnabled,
    stop() {
      clearTimeout(state.timer);
      state.conversationId = null;
    },
  };
};
