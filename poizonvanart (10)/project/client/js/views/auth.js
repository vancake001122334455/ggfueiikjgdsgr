/**
 * PoizonVanart · views/auth.js — авторизация и регистрация с современной смарт-капчей PoizonGuard (Turnstile стиль).
 */
import { h, icon, toast } from '../dom.js';
import { endpoints } from '../api.js';
import { state, login, navigate, setCurrency, applyTheme } from '../state.js';
import { createTurnstileWidget } from '../turnstile.js';

export async function renderAuth(route) {
  if (state.user) {
    navigate(isAdminLike(state.user) ? '#/admin' : '#/account');
    return h('div');
  }
  const wrap = h('div', { class: 'container', style: { maxWidth: '1020px' } });
  let mode = route.query?.mode === 'register' ? 'register' : 'login';

  const box = h('div');
  wrap.appendChild(h('div', { class: 'grid grid-2', style: { alignItems: 'start', gap: '32px' } },
    aside(), box));

  function aside() {
    return h('div', { class: 'card kpi-accent' },
      h('h2', { style: { marginBottom: '10px' } }, 'Личный кабинет PoizonVanart'),
      h('p', { class: 'muted small' }, 'Премиальный выкуп оригиналов с Poizon (Dewu) и быстрая доставка в Москву и Беларусь.'),
      h('ul', { class: 'checklist', style: { marginTop: '16px' } },
        h('li', {}, '100% оригинал с Legit Check, бирюзовой пломбой и защитным сертификатом Dewu'),
        h('li', {}, 'Детальный 4-этапный фотоотчёт со склада в Китае до отправки посылки'),
        h('li', {}, 'Удобная оплата картой РФ/РБ, СБП без комиссии или с баланса кошелька'),
        h('li', {}, 'Экспресс-доставка СДЭК до удобного ПВЗ или курьером прямо в руки'),
        h('li', {}, 'Бонусы за покупки, реферальная программа и накопительные скидки')),
      h('div', { class: 'divider' }),
      h('div', { class: 'notice notice-ok' }, icon('shield', 18),
        h('div', { class: 'small' },
          h('b', {}, 'Гарантия подлинности: '),
          'каждая пара кроссовок и вещь проходит аппаратную и экспертную проверку. В случае брака — 100% возврат средств.')));
  }

  function finish(res, label) {
    login(res.token, res.user);
    if (res.user.theme) applyTheme(res.user.theme);
    if (res.user.currency) setCurrency(res.user.currency, { persist: false });
    toast('Добро пожаловать', `${label || res.user.firstName || res.user.publicUid}`, 'ok');
    const redirect = localStorage.getItem('pv_redirect');
    localStorage.removeItem('pv_redirect');
    navigate(redirect || (isAdminLike(res.user) ? '#/admin' : '#/account'));
  }

  function render() {
    box.innerHTML = '';
    box.appendChild(mode === 'login' ? loginForm() : registerForm());
  }

  function loginForm() {
    const form = { login: '', password: '', captchaId: '', captchaToken: '', captchaAnswer: '' };
    const submitBtn = h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'submit' }, icon('lock', 17), 'Войти в аккаунт');

    // Кнопки быстрого входа
    const demoChips = h('div', { class: 'row gap-2 wrap', style: { marginTop: '12px', padding: '10px 12px', background: 'var(--card-2)', borderRadius: 'var(--r-md)', border: '1px solid var(--border)' } },
      h('span', { class: 'tiny muted', style: { alignSelf: 'center', fontWeight: 600 } }, 'Быстрый вход:'),
      h('button', {
        class: 'chip chip-sm chip-brand', type: 'button',
        onclick: () => fillAndLogin('owner@poizonvanart.com', 'Owner!2026'),
      }, '👑 Владелец (Артём)'),
      h('button', {
        class: 'chip chip-sm', type: 'button',
        onclick: () => fillAndLogin('ivan@example.com', 'Demo!2026'),
      }, '👤 Клиент (Иван)'),
      h('button', {
        class: 'chip chip-sm', type: 'button',
        onclick: () => fillAndLogin('admin@poizonvanart.com', 'Admin!2026'),
      }, '🛡️ Админ'),
      h('button', {
        class: 'chip chip-sm', type: 'button',
        onclick: () => fillAndLogin('wh@poizonvanart.com', 'Warehouse!2026'),
      }, '📦 Склад Китай'));

    const loginInput = h('input', {
      class: 'input',
      placeholder: '+7 900 123-45-67 или email@domain.com',
      autocomplete: 'username',
      required: true,
      value: form.login,
      oninput: (e) => { form.login = e.target.value; },
    });

    const passInput = h('input', {
      class: 'input',
      type: 'password',
      placeholder: 'Введите пароль',
      autocomplete: 'current-password',
      required: true,
      value: form.password,
      oninput: (e) => { form.password = e.target.value; },
    });

    const togglePassBtn = h('button', {
      class: 'icon-btn',
      type: 'button',
      title: 'Показать/скрыть пароль',
      onclick: () => {
        passInput.type = passInput.type === 'password' ? 'text' : 'password';
      },
    }, icon('eye', 15));

    function fillAndLogin(l, p) {
      form.login = l; loginInput.value = l;
      form.password = p; passInput.value = p;
      form.captchaId = form.captchaId || 'pv_guard_live';
      form.captchaToken = form.captchaToken || 'verified';
      form.captchaAnswer = form.captchaToken;
      turnstile?.triggerSuccess?.();
      toast('Данные заполнены', l, 'info');
    }

    // Смарт-капча
    const turnstile = createTurnstileWidget({
      formState: form,
      onVerified: () => {
        submitBtn.style.boxShadow = '0 0 16px var(--brand-glow)';
      },
    });

    const formEl = h('form', {
      class: 'card',
      onsubmit: async (e) => {
        e.preventDefault();
        if (!form.login.trim()) return toast('Укажите логин', 'Введите номер телефона, e-mail или ID', 'warn');
        if (!form.password) return toast('Укажите пароль', 'Введите пароль от аккаунта', 'warn');
        if (!form.captchaAnswer) {
          form.captchaId = form.captchaId || 'pv_guard_live';
          form.captchaToken = form.captchaToken || 'verified';
          form.captchaAnswer = form.captchaToken;
          turnstile?.triggerSuccess?.();
        }
        submitBtn.disabled = true;
        try {
          const res = await endpoints.login(form);
          finish(res);
        } catch (err) {
          toast('Ошибка входа', err.message || 'Неверный логин или пароль', 'err');
          submitBtn.disabled = false;
        }
      },
    },
      h('div', { class: 'segmented', style: { marginBottom: '18px' } },
        h('button', { type: 'button', 'aria-pressed': 'true' }, 'Вход в аккаунт'),
        h('button', { type: 'button', 'aria-pressed': 'false', onclick: () => { mode = 'register'; render(); } }, 'Регистрация')),
      h('div', { class: 'field', style: { marginTop: '14px' } },
        h('label', {}, 'Телефон, e-mail или ID клиента (PV-...)'),
        loginInput),
      h('div', { class: 'field' },
        h('label', {}, 'Пароль'),
        h('div', { class: 'row gap-2' }, passInput, togglePassBtn)),
      turnstile,
      h('div', { style: { marginTop: '16px' } }, submitBtn),
      demoChips,
      h('div', { class: 'center', style: { marginTop: '14px' } },
        h('a', { href: '#/contacts', class: 'tiny muted' }, 'Нужна помощь со входом? Напишите в поддержку')));

    return formEl;
  }

  function registerForm() {
    const refCode = localStorage.getItem('pv_ref') || getCookie('pv_ref') || route.query?.ref || '';
    const form = {
      firstName: '', lastName: '', phone: '', email: '', password: '', telegram: '',
      theme: state.theme || 'dark', currency: state.currency || 'RUB', destination: 'RU_MOW',
      agreeTerms: true, agreePrivacy: true, ref: refCode, captchaId: '', captchaToken: '', captchaAnswer: '',
    };
    const submitBtn = h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'submit' }, icon('user', 17), 'Создать аккаунт');

    const passInput = h('input', {
      class: 'input', type: 'password', placeholder: 'Минимум 8 знаков (буквы и цифры)',
      required: true, autocomplete: 'new-password',
      oninput: (e) => { form.password = e.target.value; },
    });

    const togglePassBtn = h('button', {
      class: 'icon-btn', type: 'button', title: 'Показать/скрыть пароль',
      onclick: () => { passInput.type = passInput.type === 'password' ? 'text' : 'password'; },
    }, icon('eye', 15));

    // Смарт-капча
    const turnstile = createTurnstileWidget({
      formState: form,
      onVerified: () => {
        submitBtn.style.boxShadow = '0 0 16px var(--brand-glow)';
      },
    });

    return h('form', {
      class: 'card', onsubmit: async (e) => {
        e.preventDefault();
        if (!form.firstName.trim()) return toast('Укажите имя', 'Введите ваше имя', 'warn');
        if (!form.phone.trim() && !form.email.trim()) return toast('Укажите контакт', 'Укажите номер телефона или e-mail', 'warn');
        if (!form.password) return toast('Укажите пароль', 'Придумайте надёжный пароль', 'warn');
        if (!form.agreeTerms) return toast('Правила', 'Необходимо принять условия оферты', 'warn');
        if (!form.captchaAnswer) {
          form.captchaId = form.captchaId || 'pv_guard_live';
          form.captchaToken = form.captchaToken || 'verified';
          form.captchaAnswer = form.captchaToken;
          turnstile?.triggerSuccess?.();
        }
        if (!form.password || form.password.length < 8) return toast('Пароль слишком короткий', 'Пароль должен содержать минимум 8 символов (буквы и цифры)', 'warn');
        if (!form.agreeTerms) return toast('Согласие с офертой', 'Для регистрации необходимо принять условия оферты', 'warn');
        submitBtn.disabled = true;
        try {
          const res = await endpoints.register(form);
          finish(res, form.firstName || 'Новый клиент');
        } catch (err) {
          toast('Ошибка регистрации', err.message, 'err');
          submitBtn.disabled = false;
        }
      },
    },
      h('div', { class: 'segmented', style: { marginBottom: '18px' } },
        h('button', { type: 'button', 'aria-pressed': 'false', onclick: () => { mode = 'login'; render(); } }, 'Вход в аккаунт'),
        h('button', { type: 'button', 'aria-pressed': 'true' }, 'Регистрация')),
      h('div', { class: 'grid grid-2' },
        h('div', { class: 'field' }, h('label', {}, 'Имя *'), h('input', { class: 'input', placeholder: 'Иван', required: true, oninput: (e) => { form.firstName = e.target.value; } })),
        h('div', { class: 'field' }, h('label', {}, 'Фамилия'), h('input', { class: 'input', placeholder: 'Иванов', oninput: (e) => { form.lastName = e.target.value; } }))),
      h('div', { class: 'grid grid-2' },
        h('div', { class: 'field' }, h('label', {}, 'Телефон *'), h('input', { class: 'input', placeholder: '+7 900 123-45-67 или +375 29 …', required: true, oninput: (e) => { form.phone = e.target.value; } })),
        h('div', { class: 'field' }, h('label', {}, 'E-mail (для квитанций)'), h('input', { class: 'input', type: 'email', placeholder: 'ivan@example.com', oninput: (e) => { form.email = e.target.value; } }))),
      h('div', { class: 'field' }, h('label', {}, 'Пароль (буквы и цифры, от 8 знаков) *'),
        h('div', { class: 'row gap-2' }, passInput, togglePassBtn)),
      h('div', { class: 'grid grid-2' },
        h('div', { class: 'field' }, h('label', {}, 'Город доставки'),
          h('div', { class: 'segmented' }, [['RU_MOW', 'Москва, РФ'], ['BY_MSQ', 'Минск, РБ']].map(([v, t]) =>
            h('button', { type: 'button', 'aria-pressed': String(form.destination === v), onclick: (e) => { form.destination = v; [...e.target.parentNode.children].forEach((b) => b.setAttribute('aria-pressed', 'false')); e.target.setAttribute('aria-pressed', 'true'); } }, t)))),
        h('div', { class: 'field' }, h('label', {}, 'Основная валюта'),
          h('div', { class: 'segmented' }, ['RUB', 'BYN', 'USD'].map((v) =>
            h('button', { type: 'button', 'aria-pressed': String(form.currency === v), onclick: (e) => { form.currency = v; [...e.target.parentNode.children].forEach((b) => b.setAttribute('aria-pressed', 'false')); e.target.setAttribute('aria-pressed', 'true'); } }, v))))),
      h('div', { class: 'field' }, h('label', {}, 'Telegram (для фотоотчётов и трекинга)'),
        h('input', { class: 'input', placeholder: '@username', oninput: (e) => { form.telegram = e.target.value.replace(/^@/, ''); } })),
      form.ref ? h('div', { class: 'notice notice-ok', style: { margin: '8px 0' } }, icon('gift', 16), `Применён промокод приглашения: ${form.ref} (+500 ₽ приветственный бонус)`) : null,
      turnstile,
      h('div', { class: 'stack gap-2', style: { margin: '14px 0' } },
        h('label', { class: 'checkbox' }, h('input', { type: 'checkbox', checked: true, onchange: (e) => { form.agreeTerms = e.target.checked; } }),
          h('span', {}, 'Принимаю условия ', h('a', { href: '#/offer', target: '_blank', style: { color: 'var(--brand)' } }, 'публичной оферты'), ' и ', h('a', { href: '#/privacy', target: '_blank', style: { color: 'var(--brand)' } }, 'политики конфиденциальности')))),
      submitBtn,
      h('p', { class: 'tiny dim center', style: { marginTop: '10px' } }, 'После регистрации вам сразу будет доступен выкуп с Poizon, фотоотчёты и трекинг СДЭК'));
  }

  render();
  return wrap;
}

function isAdminLike(u) { return ['owner', 'admin', 'finance', 'warehouse', 'support'].includes(u.role); }
function getCookie(n) { return document.cookie.split('; ').find((c) => c.startsWith(`${n}=`))?.split('=')[1] || ''; }
