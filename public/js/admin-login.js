(() => {
  const form = document.getElementById('form');
  const errorBox = document.getElementById('error');
  const button = form.querySelector('button');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    button.disabled = true;
    errorBox.hidden = true;

    try {
      const res = await fetch('/api/auth/agent-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: document.getElementById('email').value,
          password: document.getElementById('password').value,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        errorBox.textContent = data.error || 'Sign in failed. Try again.';
        errorBox.hidden = false;
        return;
      }
      window.location.href = '/admin';
    } catch {
      errorBox.textContent = 'Cannot reach the server. Check your connection.';
      errorBox.hidden = false;
    } finally {
      button.disabled = false;
    }
  });
})();
