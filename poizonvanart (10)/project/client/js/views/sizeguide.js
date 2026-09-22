/**
 * PoizonVanart · views/sizeguide.js — интерактивный размерный гид:
 * длина стопы (мм) → EUR/US/UK/CN с учётом бренда + подсказки по одежде (рост/вес).
 */
import { h, icon, toast } from '../dom.js';
import { endpoints } from '../api.js';
import { state } from '../state.js';

export async function renderSizeGuide() {
  const wrap = h('div', { class: 'container', style: { maxWidth: '1040px' } });
  wrap.appendChild(h('div', { style: { marginBottom: '24px' } },
    h('h1', {}, 'Размерный гид'),
    h('p', { class: 'lead muted' }, 'Китайские и американские размеры отличаются. Измерьте стопу в миллиметрах или укажите рост и вес — подберём размер под бренд.')));

  const tabs = h('div', { class: 'pill-tabs', style: { marginBottom: '20px' } });
  const body = h('div');
  wrap.appendChild(tabs); wrap.appendChild(body);

  let mode = 'footwear';
  const render = () => {
    tabs.innerHTML = '';
    [['footwear', 'Обувь: по длине стопы'], ['apparel', 'Одежда: по росту и весу'], ['tips', 'Как измерить']].forEach(([m, t]) =>
      tabs.appendChild(h('button', { 'aria-pressed': String(mode === m), onclick: () => { mode = m; render(); } }, t)));
    body.innerHTML = '';
    body.appendChild(mode === 'footwear' ? footwear() : mode === 'apparel' ? apparel() : tips());
  };

  function footwear() {
    const input = h('input', { class: 'input mono', type: 'number', placeholder: '265', style: { maxWidth: '150px' } });
    const brands = ['', 'salomon', 'essentials', 'nike', 'jordan', 'adidas', 'newbalance', 'stussy', 'arcteryx'];
    const brandSel = h('select', { class: 'select', style: { maxWidth: '240px' } },
      brands.map((b) => h('option', { value: b }, b ? b : 'Универсальная таблица')));
    const out = h('div');
    const find = async () => {
      const mm = Number(input.value);
      if (!mm) return toast('Введите длину стопы', 'Например, 265 мм', 'err');
      const res = await endpoints.sizeGuide({ footMm: mm, brand: brandSel.value || undefined });
      out.innerHTML = '';
      if (!res.recommendation?.row) { out.appendChild(h('div', { class: 'notice notice-warn' }, 'Не нашли размер — напишите в поддержку, подберём вручную')); return; }
      const r = res.recommendation.row;
      out.appendChild(h('div', { class: 'card kpi-accent' },
        h('div', { class: 'row gap-4 wrap' },
          big('EUR', r.eur), big('US M', r.us_m), big('US W', r.us_w), big('UK', r.uk), big('CN', r.cn), big('Стопа', `${mm} мм`)),
        h('p', { class: 'small muted', style: { marginTop: '12px' } }, res.recommendation.note)));
      out.appendChild(tablesFor(res.guides || []));
    };
    return h('div', {},
      h('div', { class: 'card' },
        h('div', { class: 'row gap-3 wrap', style: { alignItems: 'flex-end' } },
          h('div', { class: 'field', style: { marginBottom: 0 } }, h('label', {}, 'Длина стопы, мм'), input),
          h('div', { class: 'field', style: { marginBottom: 0 } }, h('label', {}, 'Бренд'), brandSel),
          h('button', { class: 'btn btn-primary', onclick: find }, icon('search', 16), 'Подобрать размер')),
        h('p', { class: 'hint', style: { marginTop: '12px' } }, 'Nike и Jordan: добавьте +5 мм к длине стопы для плотной посадки. Salomon маломерит на полразмера. Essentials — оверсайз, берите на размер меньше.')),
      out);
  }

  const big = (label, value) => h('div', { style: { textAlign: 'center' } },
    h('div', { class: 'tiny dim' }, label), h('b', { style: { fontSize: '24px', letterSpacing: '-.02em' } }, value || '—'));

  function apparel() {
    const height = h('input', { class: 'input mono', type: 'number', placeholder: '178', style: { maxWidth: '130px' } });
    const weight = h('input', { class: 'input mono', type: 'number', placeholder: '75', style: { maxWidth: '130px' } });
    const out = h('div');
    const find = async () => {
      const res = await endpoints.sizeGuide({ heightCm: height.value || undefined, weightKg: weight.value || undefined });
      out.innerHTML = '';
      const r = res.recommendation?.row;
      if (!r) { out.appendChild(h('div', { class: 'notice notice-warn' }, 'Уточните рост и вес — или выберите размер по таблице ниже')); }
      else {
        out.appendChild(h('div', { class: 'card kpi-accent' },
          h('div', { class: 'row gap-4 wrap' }, big('Размер', r.size), big('Рост', r.height_cm), big('Вес', r.weight_kg), big('Грудь', r.chest_cm), big('CN', r.cn)),
          h('p', { class: 'small muted', style: { marginTop: '12px' } }, res.recommendation.note)));
      }
      out.appendChild(tablesFor(res.guides.filter((g) => g.kind === 'apparel')));
    };
    return h('div', {},
      h('div', { class: 'card' },
        h('div', { class: 'row gap-3 wrap', style: { alignItems: 'flex-end' } },
          h('div', { class: 'field', style: { marginBottom: 0 } }, h('label', {}, 'Рост, см'), height),
          h('div', { class: 'field', style: { marginBottom: 0 } }, h('label', {}, 'Вес, кг'), weight),
          h('button', { class: 'btn btn-primary', onclick: find }, icon('search', 16), 'Подобрать размер'))),
      out);
  }

  function tablesFor(guides) {
    const cards = (guides || []).map((g) => {
      const cols = Object.keys((g.rows && g.rows[0]) || {});
      const head = h('thead', {}, h('tr', {}, cols.map((k) => h('th', {}, k))));
      const body = h('tbody', {}, (g.rows || []).map((row) =>
        h('tr', {}, cols.map((k) => h('td', { class: 'mono small' }, String(row[k] ?? '—'))))));
      const table = h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, head, body));
      const title = `${g.brand_slug ? g.brand_slug + ' · ' : ''}${g.category_slug || 'размеры'}`;
      const kindLabel = g.kind === 'footwear' ? 'обувь' : 'одежда';
      return h('div', { class: 'card' },
        h('div', { class: 'card-head' }, icon('ruler', 18), h('h4', {}, `${title} · ${kindLabel}`)),
        table,
        g.notes ? h('p', { class: 'hint', style: { marginTop: '10px' } }, g.notes) : null);
    });
    return h('div', { class: 'stack gap-4', style: { marginTop: '20px' } }, cards);
  }

  function tips() {
    const footSteps = [
      'Поставьте лист бумаги на твёрдый пол и прижмите его к стене',
      'Встаньте на лист: пятка касается стены, вес равномерно на обеих ногах',
      'Отметьте самую выступающую точку большого пальца',
      'Измерьте расстояние от края листа до отметки — это длина стопы в мм',
      'Измерьте обе ноги и берите большее значение',
      'Измеряйте вечером: к концу дня стопа немного отекает',
    ];
    const apparelTips = [
      'Китайский L ≈ европейский M — сверяйте обхват груди в сантиметрах',
      'Оверсайз-бренды (Essentials, Stüssy): берите на размер меньше',
      'Технические куртки (Arc’teryx): учитывайте утепляющий слой — добавьте размер',
      'Худи из плотного флиса 480 г/м² садятся плотнее после первой стирки',
      'Если вы между размерами — берите больший: обмен из Китая невозможен',
    ];

    const footCard = h('div', { class: 'card' },
      h('h3', {}, 'Как измерить стопу'),
      h('ol', { class: 'checklist', style: { marginTop: '12px' } },
        footSteps.map((t) => h('li', {}, t))));

    const apparelCard = h('div', { class: 'card' },
      h('h3', {}, 'Подбор одежды по росту и весу'),
      h('ul', { class: 'checklist', style: { marginTop: '12px' } },
        apparelTips.map((t) => h('li', {}, t))));

    const helpCard = h('div', { class: 'card' },
      h('h3', {}, 'Что делать, если размер не подошёл'),
      h('p', { class: 'small muted' },
        'Обмен и возврат по причине «не подошёл размер» после отправки из Китая невозможен — товар выкупается под конкретный заказ. ',
        'Поэтому рекомендуем: свериться с этим гидом, почитать отзывы на модель (маломерит или большемерит) и задать вопрос в чат поддержки — менеджер проверит фактические замеры конкретной позиции на складе.'),
      h('div', { class: 'btn-group', style: { marginTop: '12px' } },
        h('a', { class: 'btn btn-ghost', href: '#/refund' }, 'Правила возврата'),
        h('a', { class: 'btn btn-ghost', href: '#/contacts' }, 'Написать в поддержку')));

    return h('div', { class: 'grid grid-2' }, footCard, apparelCard, helpCard);
  }

  render();
  return wrap;
}
