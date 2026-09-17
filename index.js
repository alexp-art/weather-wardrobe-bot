import { Bot, Keyboard } from 'grammy';
import { createClient } from '@supabase/supabase-js';
import cron from 'node-cron';
import dotenv from 'dotenv';

dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const bot = new Bot(process.env.BOT_TOKEN);

const userState = new Map();

const mainKeyboard = new Keyboard()
  .text('🌤 Погода сейчас')
  .text('⚙️ Изменить город / время')
  .resized();

// Генерация рекомендаций по одежде
function getOutfitRecommendation(temp, feelsLike, precipitation, windSpeed) {
  let recommendation = '';

  if (feelsLike < -10) {
    recommendation = '❄️ Зимний пуховик, тёплая шапка, шарф, варежки и термобелье';
  } else if (feelsLike >= -10 && feelsLike < 0) {
    recommendation = '🧥 Зимняя куртка, шапка, перчатки и тёплая обувь';
  } else if (feelsLike >= 0 && feelsLike < 10) {
    recommendation = '🧥 Демисезонная куртка, легкая шапка, закрытая обувь';
  } else if (feelsLike >= 10 && feelsLike < 18) {
    recommendation = '🧥 Ветровка или худи, джинсы, кроссовки';
  } else if (feelsLike >= 18 && feelsLike < 23) {
    recommendation = '👕 Футболка, джинсы, легкая кофта на вечер';
  } else {
    recommendation = '🩳 Футболка, шорты/юбка, головной убор от солнца';
  }

  const extras = [];
  if (precipitation > 40) extras.push('☔ Возьмите зонт');
  if (windSpeed > 8) extras.push('💨 Непродуваемая одежда');

  if (extras.length > 0) {
    recommendation += ` (${extras.join(', ')})`;
  }

  return recommendation;
}

// Запрос почасовой погоды от Open-Meteo с заголовком User-Agent
async function getWeatherForecast(lat, lon) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,apparent_temperature,precipitation_probability,wind_speed_10m&forecast_days=1&timezone=auto`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'WeatherWardrobeBot/1.0 (https://github.com)'
      }
    });
    if (!response.ok) throw new Error(`Weather API error: ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error('Ошибка получения погоды:', error);
    return null;
  }
}

// Поиск координат и часового пояса
async function geocodeCity(cityName) {
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cityName)}&count=1&language=ru`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'WeatherWardrobeBot/1.0 (https://github.com)'
      }
    });
    const data = await response.json();

    if (!data.results || data.results.length === 0) return null;

    const city = data.results[0];
    return {
      name: city.name,
      lat: city.latitude,
      lon: city.longitude,
      timezone: city.timezone || 'UTC'
    };
  } catch (error) {
    console.error('Ошибка геокодинга:', error);
    return null;
  }
}

// Извлечение данных для конкретного часа из почасового массива
function getHourData(hourly, hour) {
  const temp = Math.round(hourly.temperature_2m[hour]);
  const feelsLike = Math.round(hourly.apparent_temperature[hour]);
  const precip = hourly.precipitation_probability[hour] || 0;
  const wind = hourly.wind_speed_10m[hour];
  
  return {
    temp,
    feelsLike,
    precip,
    wind,
    outfit: getOutfitRecommendation(temp, feelsLike, precip, wind)
  };
}

// Формирование подробного отчета по периодам суток
async function generateWeatherReport(user) {
  const forecast = await getWeatherForecast(user.latitude, user.longitude);
  if (!forecast || !forecast.hourly) {
    return '⚠️ Сервис погоды временно недоступен, попробуйте чуть позже.';
  }

  const h = forecast.hourly;

  // Индексы часов: Утро (08:00), День (14:00), Вечер (19:00), Ночь (23:00)
  const morning = getHourData(h, 8);
  const day = getHourData(h, 14);
  const evening = getHourData(h, 19);
  const night = getHourData(h, 23);

  const now = new Date();
  const dateStr = now.toLocaleDateString('ru-RU', {
    timeZone: user.timezone,
    day: 'numeric',
    month: 'long',
    weekday: 'short'
  });

  return (
    `📍 *${user.city_name}* — Прогноз на сегодня (${dateStr})\n\n` +
    
    `🌅 *Утро (08:00):* ${morning.temp}°C (ощущается ${morning.feelsLike}°C)\n` +
    `💡 ${morning.outfit}\n\n` +

    `☀️ *День (14:00):* ${day.temp}°C (ощущается ${day.feelsLike}°C)\n` +
    `💡 ${day.outfit}\n\n` +

    `🌆 *Вечер (19:00):* ${evening.temp}°C (ощущается ${evening.feelsLike}°C)\n` +
    `💡 ${evening.outfit}\n\n` +

    `🌙 *Ночь (23:00):* ${night.temp}°C (ощущается ${night.feelsLike}°C)\n` +
    `💡 ${night.outfit}`
  );
}

// --- ОБРАБОТЧИКИ СООБЩЕНИЙ ---

bot.command('start', async (ctx) => {
  const chatId = ctx.chat.id;
  userState.set(chatId, { step: 'WAITING_CITY' });

  await ctx.reply(
    'Привет! 👋 Я бот «Погода & Гардероб 24/7».\n\n' +
    'Я буду присылать тебе удобный прогноз погоды на весь день (Утро, День, Вечер, Ночь) и подбирать гардероб под каждый период.\n\n' +
    'Введи название своего города (например, *Москва* или *Тирасполь*):',
    { parse_mode: 'Markdown' }
  );
});

bot.on('message:text', async (ctx) => {
  const chatId = ctx.chat.id;
  const text = ctx.message.text.trim();
  const state = userState.get(chatId) || {};

  if (text === '🌤 Погода сейчас') {
    const { data: user } = await supabase.from('users').select('*').eq('telegram_id', chatId).single();
    if (!user) {
      userState.set(chatId, { step: 'WAITING_CITY' });
      return ctx.reply('Сначала настройте город. Введите название вашего города:');
    }
    const report = await generateWeatherReport(user);
    return ctx.reply(report, { parse_mode: 'Markdown', reply_markup: mainKeyboard });
  }

  if (text === '⚙️ Изменить город / время') {
    userState.set(chatId, { step: 'WAITING_CITY' });
    return ctx.reply('Введите новое название вашего города:');
  }

  if (state.step === 'WAITING_CITY') {
    const geoData = await geocodeCity(text);

    if (!geoData) {
      return ctx.reply('❌ Город не найден. Пожалуйста, проверьте написание и введите снова:');
    }

    userState.set(chatId, {
      step: 'WAITING_TIME',
      cityData: geoData
    });

    return ctx.reply(
      `Город *${geoData.name}* найден! ✅\n\n` +
      `Теперь введите время для ежедневного утреннего отчета в формате *ЧЧ:ММ* (например, \`07:30\`):`,
      { parse_mode: 'Markdown' }
    );
  }

  if (state.step === 'WAITING_TIME') {
    const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;

    if (!timeRegex.test(text)) {
      return ctx.reply('❌ Неверный формат времени. Введите время в формате *ЧЧ:ММ* (например, \`07:30\`):', { parse_mode: 'Markdown' });
    }

    const { cityData } = state;

    const { error } = await supabase.from('users').upsert({
      telegram_id: chatId,
      city_name: cityData.name,
      latitude: cityData.lat,
      longitude: cityData.lon,
      timezone: cityData.timezone,
      notification_time: text
    });

    if (error) {
      console.error('Ошибка Supabase:', error);
      return ctx.reply('Произошла ошибка при сохранении данных. Попробуйте снова.');
    }

    userState.delete(chatId);

    return ctx.reply(
      `Отлично! Всё настроено 🎉\n\n` +
      `📍 Город: *${cityData.name}*\n` +
      `⏰ Время рассылки: *${text}*\n\n` +
      `Нажмите кнопку ниже, чтобы посмотреть сводку!`,
      { parse_mode: 'Markdown', reply_markup: mainKeyboard }
    );
  }
});

// Крон-рассылка
cron.schedule('* * * * *', async () => {
  try {
    const { data: users, error } = await supabase.from('users').select('*');
    if (error || !users) return;

    const now = new Date();

    for (const user of users) {
      if (!user.notification_time || !user.timezone) continue;

      const localTimeStr = now.toLocaleTimeString('ru-RU', {
        timeZone: user.timezone,
        hour: '2-digit',
        minute: '2-digit'
      });

      if (localTimeStr === user.notification_time) {
        const report = await generateWeatherReport(user);
        await bot.api.sendMessage(user.telegram_id, report, {
          parse_mode: 'Markdown',
          reply_markup: mainKeyboard
        }).catch(err => console.error(`Ошибка отправки ${user.telegram_id}:`, err.message));
      }
    }
  } catch (err) {
    console.error('Ошибка Cron:', err);
  }
});

bot.start({
  onStart: () => console.log('🤖 Бот "Погода & Гардероб" успешно перезапущен!')
});
