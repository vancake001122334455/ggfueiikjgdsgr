/**
 * PoizonVanart · Интеграция со службой доставки СДЭК (CDEK) и пунктами выдачи (ПВЗ).
 * Обеспечивает выбор ПВЗ по городам России и Беларуси, расчет курьерской доставки до двери,
 * и отслеживание статуса СДЭК-накладных.
 */

export const CDEK_CITIES = [
  { code: 'RU_MOW', name: 'Москва', country: 'RU', hub: 'Хаб Москва Юг' },
  { code: 'RU_SPB', name: 'Санкт-Петербург', country: 'RU', hub: 'Хаб Москва Юг' },
  { code: 'BY_MSQ', name: 'Минск', country: 'BY', hub: 'Хаб Минск Центральный' },
  { code: 'RU_EKB', name: 'Екатеринбург', country: 'RU', hub: 'Хаб Москва Юг' },
  { code: 'RU_KZN', name: 'Казань', country: 'RU', hub: 'Хаб Москва Юг' },
  { code: 'RU_OVB', name: 'Новосибирск', country: 'RU', hub: 'Хаб Москва Юг' },
  { code: 'RU_GOJ', name: 'Нижний Новгород', country: 'RU', hub: 'Хаб Москва Юг' },
  { code: 'RU_ROV', name: 'Ростов-на-Дону', country: 'RU', hub: 'Хаб Москва Юг' },
  { code: 'RU_KRR', name: 'Краснодар', country: 'RU', hub: 'Хаб Москва Юг' },
  { code: 'RU_SAM', name: 'Самара', country: 'RU', hub: 'Хаб Москва Юг' },
  { code: 'RU_UFA', name: 'Уфа', country: 'RU', hub: 'Хаб Москва Юг' },
];

export const CDEK_PVZ_POINTS = {
  RU_MOW: [
    {
      code: 'MSK102',
      name: 'ПВЗ Тверская',
      address: 'г. Москва, ул. Тверская, д. 18, корп. 1',
      metro: 'м. Пушкинская / Тверская (2 мин пешком)',
      workTime: 'Пн-Вс 09:00–21:00',
      phone: '+7 (495) 009-04-05',
      hasFitting: true,
      hasCardPayment: true,
      note: 'Вход с Малого Палашевского пер., 1 этаж',
    },
    {
      code: 'MSK245',
      name: 'ПВЗ Красная Пресня (Сити)',
      address: 'г. Москва, ул. Красная Пресня, д. 28, стр. 2',
      metro: 'м. Улица 1905 года (3 мин пешком)',
      workTime: 'Пн-Вс 10:00–21:00',
      phone: '+7 (495) 009-04-05',
      hasFitting: true,
      hasCardPayment: true,
      note: 'Удобная просторная примерочная для обуви и одежды',
    },
    {
      code: 'MSK318',
      name: 'ПВЗ Проспект Мира',
      address: 'г. Москва, пр-кт Мира, д. 40',
      metro: 'м. Проспект Мира',
      workTime: 'Пн-Вс 09:00–21:00',
      phone: '+7 (495) 009-04-05',
      hasFitting: true,
      hasCardPayment: true,
      note: 'Отдельный вход со стороны Проспекта',
    },
    {
      code: 'MSK412',
      name: 'ПВЗ Ленинский проспект',
      address: 'г. Москва, Ленинский пр-кт, д. 64/11',
      metro: 'м. Университет',
      workTime: 'Пн-Вс 10:00–20:00',
      phone: '+7 (495) 009-04-05',
      hasFitting: true,
      hasCardPayment: true,
      note: 'Рядом бесплатная парковка',
    },
    {
      code: 'MSK589',
      name: 'ПВЗ Авиапарк (Ходынское поле)',
      address: 'г. Москва, Ходынский б-р, д. 2',
      metro: 'м. ЦСКА (1 мин)',
      workTime: 'Пн-Вс 10:00–22:00',
      phone: '+7 (495) 009-04-05',
      hasFitting: true,
      hasCardPayment: true,
      note: 'ТЦ Авиапарк, паркинг -1 уровень, сектор B',
    },
  ],
  RU_SPB: [
    {
      code: 'SPB04',
      name: 'ПВЗ Невский',
      address: 'г. Санкт-Петербург, Невский пр-кт, д. 88',
      metro: 'м. Маяковская (1 мин)',
      workTime: 'Пн-Вс 09:00–21:00',
      phone: '+7 (812) 640-01-02',
      hasFitting: true,
      hasCardPayment: true,
      note: 'Вход под арку, парадная 2',
    },
    {
      code: 'SPB77',
      name: 'ПВЗ Московский',
      address: 'г. Санкт-Петербург, Московский пр-кт, д. 172',
      metro: 'м. Парк Победы',
      workTime: 'Пн-Вс 10:00–21:00',
      phone: '+7 (812) 640-01-02',
      hasFitting: true,
      hasCardPayment: true,
      note: 'Большая зона примерки обуви',
    },
    {
      code: 'SPB112',
      name: 'ПВЗ Комендантский',
      address: 'г. Санкт-Петербург, Комендантский пр-кт, д. 13, корп. 1',
      metro: 'м. Комендантский проспект',
      workTime: 'Пн-Вс 10:00–21:00',
      phone: '+7 (812) 640-01-02',
      hasFitting: true,
      hasCardPayment: true,
      note: 'ТК Голубой, 1 этаж',
    },
  ],
  BY_MSQ: [
    {
      code: 'MSQ01',
      name: 'ПВЗ Победителей (Галерея Минск)',
      address: 'г. Минск, пр-кт Победителей, д. 65',
      metro: 'м. Немига / Фрунзенская',
      workTime: 'Пн-Вс 09:00–21:00',
      phone: '+375 (17) 388-75-55',
      hasFitting: true,
      hasCardPayment: true,
      note: 'Центральный пункт СДЭК в Беларуси',
    },
    {
      code: 'MSQ08',
      name: 'ПВЗ Независимости',
      address: 'г. Минск, пр-кт Независимости, д. 168/1',
      metro: 'м. Уручье',
      workTime: 'Пн-Вс 10:00–20:00',
      phone: '+375 (17) 388-75-55',
      hasFitting: true,
      hasCardPayment: true,
      note: 'Удобный подъезд с кольцевой МКАД',
    },
    {
      code: 'MSQ14',
      name: 'ПВЗ Притыцкого (Скала)',
      address: 'г. Минск, ул. Притыцкого, д. 29',
      metro: 'м. Спортивная',
      workTime: 'Пн-Вс 10:00–21:00',
      phone: '+375 (17) 388-75-55',
      hasFitting: true,
      hasCardPayment: true,
      note: 'ТЦ Тивали, цокольный этаж',
    },
    {
      code: 'MSQ22',
      name: 'ПВЗ Дзержинского',
      address: 'г. Минск, пр-кт Дзержинского, д. 104',
      metro: 'м. Петровщина',
      workTime: 'Пн-Вс 10:00–20:00',
      phone: '+375 (17) 388-75-55',
      hasFitting: true,
      hasCardPayment: true,
      note: 'ТЦ Титан, вход со стороны проспекта',
    },
  ],
  RU_EKB: [
    {
      code: 'EKB12',
      name: 'ПВЗ Ленина',
      address: 'г. Екатеринбург, пр-кт Ленина, д. 48',
      metro: 'м. Площадь 1905 года',
      workTime: 'Пн-Вс 10:00–20:00',
      phone: '+7 (343) 311-00-50',
      hasFitting: true,
      hasCardPayment: true,
    },
  ],
  RU_KZN: [
    {
      code: 'KZN05',
      name: 'ПВЗ Баумана',
      address: 'г. Казань, ул. Баумана, д. 58',
      metro: 'м. Кремлёвская',
      workTime: 'Пн-Вс 09:00–21:00',
      phone: '+7 (843) 205-02-02',
      hasFitting: true,
      hasCardPayment: true,
    },
  ],
  RU_OVB: [
    {
      code: 'OVB18',
      name: 'ПВЗ Красный проспект',
      address: 'г. Новосибирск, Красный пр-кт, д. 77',
      metro: 'м. Красный проспект',
      workTime: 'Пн-Вс 09:00–20:00',
      phone: '+7 (383) 209-00-01',
      hasFitting: true,
      hasCardPayment: true,
    },
  ],
};

export function getPvzList(cityCode) {
  if (cityCode && CDEK_PVZ_POINTS[cityCode]) {
    return CDEK_PVZ_POINTS[cityCode];
  }
  // По умолчанию возвращаем московские ПВЗ
  return CDEK_PVZ_POINTS.RU_MOW;
}

export function findPvzByCode(pvzCode) {
  for (const city of Object.keys(CDEK_PVZ_POINTS)) {
    const found = CDEK_PVZ_POINTS[city].find((p) => p.code === pvzCode);
    if (found) return { ...found, cityCode: city };
  }
  return null;
}

export function calcDeliveryOptions({ destination, weightKg = 1.4, currency = 'RUB', rates = {} }) {
  const isByn = currency === 'BYN';
  const courierSurchargeRub = 350;
  const courierSurchargeByn = 12;
  const surcharge = isByn ? courierSurchargeByn : courierSurchargeRub;

  return [
    {
      id: 'cdek_pvz',
      name: 'СДЭК · Пункт выдачи (ПВЗ)',
      badge: 'Рекомендуем',
      price: 0,
      priceLabel: 'Включено в карго-тариф',
      etaDays: destination === 'BY_MSQ' ? '1–2 дня после растаможки' : '2–3 дня после хаба МСК',
      description: 'Бесплатное хранение 7 дней, проверка и примерка обуви/одежды на месте.',
      requiresPvzSelection: true,
    },
    {
      id: 'cdek_courier',
      name: 'СДЭК · Курьер до двери',
      badge: '+350 ₽ / 12 BYN',
      price: surcharge,
      priceLabel: `+${surcharge} ${currency}`,
      etaDays: destination === 'BY_MSQ' ? '2–3 дня после растаможки' : '3–4 дня после хаба МСК',
      description: 'Доставка лично в руки курьером СДЭК по указанному адресу в удобный интервал.',
      requiresPvzSelection: false,
    },
    {
      id: 'pickup_hub',
      name: 'Самовывоз из логистического хаба Vanart',
      badge: '0 ₽',
      price: 0,
      priceLabel: 'Бесплатно',
      etaDays: 'В день прибытия карго',
      description: destination === 'BY_MSQ' ? 'Минск, пр-кт Победителей, 65' : 'Москва, ММДЦ «Москва-Сити», Башня Федерация',
      requiresPvzSelection: false,
    },
  ];
}
