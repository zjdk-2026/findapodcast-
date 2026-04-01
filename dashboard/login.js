'use strict';

async function sendMagicLink() {
  const emailInput = document.getElementById('login-email');
  const btn = document.getElementById('login-btn');
  const errorEl = document.getElementById('login-error');
  const email = emailInput?.value.trim();

  errorEl.style.display = 'none';

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errorEl.textContent = 'Please enter a valid email address.';
    errorEl.style.display = 'block';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Sending…';

  try {
    const res = await fetch('/api/auth/magic-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await res.json();

    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Something went wrong.');
    }

    document.getElementById('sent-email').textContent = email;
    document.getElementById('input-state').style.display = 'none';
    document.getElementById('sent-state').style.display = 'block';
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Send me a link';
  }
}

window.sendMagicLink = sendMagicLink;

document.getElementById('login-email')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendMagicLink();
});
