const form = document.querySelector('#login-form');
const errorMessage = document.querySelector('#login-error');
const submitButton = form.querySelector('button[type="submit"]');

async function checkSession() {
  try {
    const response = await fetch('/api/auth/session', { credentials: 'same-origin' });
    if (response.ok && (await response.json()).authenticated) location.replace('/');
  } catch {
    errorMessage.textContent = 'The sign-in service is temporarily unavailable.';
    errorMessage.hidden = false;
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorMessage.hidden = true;
  submitButton.disabled = true;
  submitButton.querySelector('span').textContent = 'Checking';

  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: form.elements.username.value,
        password: form.elements.password.value,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'Unable to sign in.');
    location.replace('/');
  } catch (error) {
    errorMessage.textContent = error.message || 'The sign-in service is temporarily unavailable.';
    errorMessage.hidden = false;
  } finally {
    submitButton.disabled = false;
    submitButton.querySelector('span').textContent = 'Continue';
  }
});

checkSession();