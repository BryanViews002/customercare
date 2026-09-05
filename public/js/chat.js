(async () => {
  const els = {
    messages: document.getElementById('messages'),
    typing: document.getElementById('typing'),
    form: document.getElementById('composer'),
    input: document.getElementById('input'),
    sendBtn: document.getElementById('send'),
  };
  const subhead = document.getElementById('subhead');

  /** Starter questions shown before the visitor has written anything. */
  const COMMON_QUESTIONS = [
    'Where is my order?',
    'I was charged twice',
    'How do I request a refund?',
    'Change my delivery address',
    'I need to cancel my subscription',
    'I can’t sign in to my account',
  ];

  const meRes = await fetch('/api/me').then((r) => r.json());
  // The page itself mints the guest session, so a missing user means the
  // cookie was blocked — a reload through the server route is the fix.
  if (!meRes.user) return window.location.reload();
  const me = meRes.user;

  const socket = io();

  /** Welcome panel: a greeting plus one-tap versions of the usual questions. */
  function welcome() {
    const wrap = document.createElement('div');
    wrap.className = 'welcome';

    const title = document.createElement('h3');
    title.textContent = 'How can we help?';

    const lead = document.createElement('p');
    lead.textContent = 'Pick a common question below, or write your own.';

    const grid = document.createElement('div');
    grid.className = 'question-grid';
    for (const question of COMMON_QUESTIONS) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'question';
      chip.textContent = question;
      chip.addEventListener('click', () => thread.sendText(question));
      grid.append(chip);
    }

    wrap.append(title, lead, grid);
    return wrap;
  }

  const thread = window.createThread({ socket, me, els, emptyState: welcome });

  socket.on('ready', () => {
    socket.emit('conversation:join', {}, (reply) => {
      if (reply?.error) {
        els.messages.textContent = reply.error;
        return;
      }
      thread.load(reply);
      applyStatus(reply.conversation.status);
    });
  });

  socket.on('conversation:updated', (patch) => {
    if (patch.id !== thread.conversationId) return;
    thread.setStatus(patch.status);
    applyStatus(patch.status);
  });

  // The status line stays empty unless something is actually wrong.
  socket.on('disconnect', () => (subhead.textContent = 'Reconnecting…'));
  socket.on('connect', () => (subhead.textContent = ''));

  function applyStatus(status) {
    const closed = status === 'closed';
    thread.setComposerEnabled(
      !closed,
      'This conversation was marked resolved. Start a new message to reopen it.'
    );
    document.title = closed ? 'Support chat (resolved)' : 'Support chat';
  }
})();
