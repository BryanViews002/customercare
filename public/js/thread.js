/**
 * Shared conversation view used by both the customer page and the agent
 * console. Renders history, streams new messages, and owns the composer.
 * All message text is written with textContent — never innerHTML.
 */
window.createThread = function createThread({ socket, me, els, emptyState }) {
  const state = {
    conversationId: null,
    status: 'open',
    messages: [],
    loadingMore: false,
    exhausted: false,
    lastReadByPeer: 0,
    typingTimer: null,
    typingSent: false,
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

  /* ------------------------------------------------------------ render -- */

  function messageNode(message, previous) {
    const wrap = document.createElement('div');
    const isMine = message.senderId === me.id;
    wrap.className = `msg ${isMine ? 'out' : 'in'}`;
    wrap.dataset.id = message.id;

    const newGroup = !previous || previous.senderId !== message.senderId ||
      message.createdAt - previous.createdAt > 5 * 60_000;
    if (newGroup) {
      wrap.classList.add('start');
      if (!isMine) {
        const who = document.createElement('div');
        who.className = 'who-line';
        who.textContent = message.senderRole === 'admin'
          ? `${message.senderName} · Support`
          : message.senderName;
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
    if (!mine || state.lastReadByPeer < mine.createdAt) return;
    const node = els.messages.querySelector(`[data-id="${CSS.escape(mine.id)}"]`);
    if (!node) return;
    const tag = document.createElement('div');
    tag.className = 'meta receipt';
    tag.textContent = 'Seen';
    node.append(tag);
  }

  function appendMessage(message) {
    const stick = nearBottom();
    if (state.messages.some((m) => m.id === message.id)) return;

    // Reconcile the optimistic bubble, if this is our own echo.
    const pending = els.messages.querySelector('.msg.pending');
    if (pending && message.senderId === me.id && pending.dataset.body === message.body) {
      pending.remove();
    }

    state.messages.push(message);
    render();
    if (stick || message.senderId === me.id) scrollToBottom();
    if (message.senderId !== me.id && document.hasFocus()) markRead();
  }

  /* ------------------------------------------------------------ sending -- */

  function optimistic(body) {
    const wrap = document.createElement('div');
    wrap.className = 'msg out pending start';
    wrap.dataset.body = body;
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
  function send(text) {
    const body = (text ?? els.input.value).trim();
    if (!body || !state.conversationId || els.input.disabled) return;

    els.input.value = '';
    els.input.style.height = 'auto';
    stopTyping();
    const node = optimistic(body);

    socket.emit('message:send', { conversationId: state.conversationId, body }, (reply) => {
      if (reply?.error) {
        node.classList.remove('pending');
        node.classList.add('failed');
        node.querySelector('.meta').textContent = reply.error;
        return;
      }
      node.remove();
      appendMessage(reply.message);
    });
  }

  /* ------------------------------------------------------------- typing -- */

  function stopTyping() {
    clearTimeout(state.typingTimer);
    if (state.typingSent && state.conversationId) {
      socket.emit('typing', { conversationId: state.conversationId, isTyping: false });
      state.typingSent = false;
    }
  }

  function noteTyping() {
    if (!state.conversationId) return;
    if (!state.typingSent) {
      socket.emit('typing', { conversationId: state.conversationId, isTyping: true });
      state.typingSent = true;
    }
    clearTimeout(state.typingTimer);
    state.typingTimer = setTimeout(stopTyping, 2500);
  }

  let typingClear = null;
  function showTyping(name, isTyping) {
    clearTimeout(typingClear);
    els.typing.textContent = isTyping ? `${name} is typing…` : '';
    if (isTyping) typingClear = setTimeout(() => (els.typing.textContent = ''), 4000);
  }

  /* --------------------------------------------------------------- read -- */

  function markRead() {
    if (state.conversationId) {
      socket.emit('conversation:read', { conversationId: state.conversationId });
    }
  }

  /* ------------------------------------------------------ older history -- */

  async function loadOlder() {
    if (state.loadingMore || state.exhausted || state.messages.length === 0) return;
    state.loadingMore = true;
    const before = state.messages[0].id;
    const previousHeight = els.messages.scrollHeight;

    socket.emit(
      'messages:history',
      { conversationId: state.conversationId, before },
      (reply) => {
        state.loadingMore = false;
        if (reply?.error || !reply?.messages?.length) {
          state.exhausted = true;
          return;
        }
        state.messages = [...reply.messages, ...state.messages];
        render();
        els.messages.scrollTop = els.messages.scrollHeight - previousHeight;
      }
    );
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

  // The composer is the only place a message can start, so let callers reach it.
  const sendText = (text) => send(text);

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

  window.addEventListener('focus', () => {
    if (state.conversationId && nearBottom()) markRead();
  });

  /* ------------------------------------------------------ socket wiring -- */

  socket.on('message:new', (message) => {
    if (message.conversationId === state.conversationId) appendMessage(message);
  });

  socket.on('typing', (payload) => {
    if (payload.conversationId === state.conversationId) {
      showTyping(payload.name, payload.isTyping);
    }
  });

  socket.on('conversation:read', (payload) => {
    if (payload.conversationId === state.conversationId && payload.role !== me.role) {
      state.lastReadByPeer = payload.at;
      renderReceipt();
    }
  });

  return {
    get conversationId() {
      return state.conversationId;
    },
    get status() {
      return state.status;
    },
    /** Swap the view to a conversation and paint its history. */
    load({ conversation, messages }) {
      state.conversationId = conversation.id;
      state.status = conversation.status;
      state.messages = messages;
      state.exhausted = messages.length < 50;
      state.lastReadByPeer = 0;
      els.typing.textContent = '';
      render();
      scrollToBottom();
      markRead();
    },
    setStatus(status) {
      state.status = status;
    },
    sendText,
    setComposerEnabled,
    clear() {
      state.conversationId = null;
      state.messages = [];
      els.messages.replaceChildren();
      els.typing.textContent = '';
    },
  };
};
