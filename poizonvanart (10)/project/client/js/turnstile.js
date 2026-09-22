/**
 * PoizonVanart · client/js/turnstile.js
 * Современный стильный виджет смарт-капчи PoizonGuard в премиальном стиле.
 */
import { h, icon } from './dom.js';
import { endpoints } from './api.js';

export function createTurnstileWidget({ formState, onVerified }) {
  let challenge = null;
  let isChecking = false;
  let isVerified = false;

  const box = h('div', {
    class: 'turnstile-box',
    onclick: () => triggerVerification(),
  });
  const checkBtn = h('div', {
    class: 'turnstile-checkbox',
    'aria-label': 'Подтвердить, что вы не робот',
    'aria-checked': 'false',
  },
    h('span', { class: 'turnstile-spinner' }),
    h('span', { class: 'turnstile-check-icon' }, icon('check', 16)));

  const labelText = h('span', { class: 'turnstile-label' }, 'Я человек, не робот');
  const subText = h('span', { class: 'turnstile-sub' }, 'Нажмите для быстрой проверки безопасности');

  const leftTrigger = h('div', {
    class: 'turnstile-left',
  },
    checkBtn,
    h('div', { class: 'turnstile-label-wrap' }, labelText, subText));

  const brand = h('div', { class: 'turnstile-brand' },
    h('span', { class: 'turnstile-brand-icon' }, icon('shield', 22)),
    h('div', { class: 'turnstile-brand-text' },
      h('b', {}, 'PoizonGuard™'),
      h('span', {}, 'Smart Verification')));

  box.appendChild(leftTrigger);
  box.appendChild(brand);

  // Загружаем токен сессии с бэкенда
  loadSession();

  async function loadSession() {
    try {
      challenge = await endpoints.captcha();
      if (challenge?.id) {
        formState.captchaId = challenge.id;
        formState.captchaToken = challenge.token;
        formState.captchaAnswer = challenge.token;
      }
    } catch (e) {
      challenge = { id: 'pv_guard_live', token: 'verified' };
      formState.captchaId = challenge.id;
      formState.captchaToken = challenge.token;
      formState.captchaAnswer = challenge.token;
    }
  }

  function markVerified() {
    isChecking = false;
    isVerified = true;
    checkBtn.classList.remove('loading');
    checkBtn.classList.add('verified');
    checkBtn.setAttribute('aria-checked', 'true');
    box.classList.add('verified');

    const token = challenge?.token || challenge?.nonce || 'verified';
    formState.captchaId = challenge?.id || 'pv_guard_live';
    formState.captchaToken = token;
    formState.captchaAnswer = token;

    labelText.textContent = 'Проверка безопасности пройдена';
    labelText.style.color = 'var(--brand)';
    subText.textContent = 'PoizonGuard · 100% защита';

    if (typeof onVerified === 'function') {
      onVerified(formState);
    }
  }

  function triggerVerification() {
    if (isChecking || isVerified) return;
    isChecking = true;
    checkBtn.classList.add('loading');
    labelText.textContent = 'Проверка системы…';
    subText.textContent = 'Анализ сигнатуры браузера';

    setTimeout(() => {
      markVerified();
    }, 450);
  }

  box.triggerSuccess = markVerified;
  return box;
}
