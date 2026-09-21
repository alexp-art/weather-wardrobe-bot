import { Bot, Keyboard, InlineKeyboard } from 'grammy';
import { createClient } from '@supabase/supabase-js';
import cron from 'node-cron';
import dotenv from 'dotenv';
import axios from 'axios';
import http from 'http';

dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const bot = new Bot(process.env.BOT_TOKEN);

// Укажите ваш личный Telegram ID для доступа к команде /stats
const ADMIN_ID = 123456789; 

const userState = new Map();

const mainKeyboard = new Keyboard()
  .text('🌤 Погода сейчас')
  .text('⚙️ Изменить город / время')
  .row()
  .text('🔕 Отключить рассылку')
  .resized();

// Клавиатура с часами для детального просмотра
const hoursInlineKeyboard = new InlineKeyboard()
  .text('09:00', 'hour_9').text('12:00', 'hour_12').text('15:00', 'hour_15')
  .row()
  .text('18:00', 'hour_18').text('21:00', 'hour_21');

function getOutfitRecommendation(temp, feelsLike, precipitation, windSpeed, uv, pressure) {
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
  if (temp <= 1 && precipitation > 20) extras.push('🧊 Осторожно, гололедица!');
  if (uv >= 3 && uv < 6) extras.push('🧴 SPF 30+');
  else if (uv >= 6) extras.push('🕶 Очки и SPF 50+');
  if (pressure < 1002) extras.push('🩺 Низкое давление');

  if (extras.length > 0) {
    recommendation += `\n⚠️ *Детали:* ${extras.join(' • ')}`;
  }

  return recommendation;
}

async function getWeatherForecast(cityName) {
  const apiKey = process.env.WEATHER_API_KEY;
  if (!apiKey) return { error: 'Переменная WEATHER_API_KEY не найдена.' };

  try {
    const url = `https://api.weatherapi.com/v1/forecast.json?key=${apiKey.trim()}&q=${encodeURIComponent(cityName)}&days=1&aqi=no&alerts=no&lang=ru`;
    const response = await axios.get(url, { timeout: 10000 });
    return { data: response.data };
  } catch (error) {
    const msg = error.response?.data?.error?.message || error.message;
    return { error: `Ошибка API Погоды: ${msg}` };
  }
}

function parseHourData(hourObj) {
  const temp = Math.round(hourObj.temp_c);
  const feelsLike = Math.round(hourObj.feelslike_c);
  const precip = hourObj.chance_of_rain || 0;
  const wind = Math.round(hourObj.wind_kph / 3.6);
  const humidity = hourObj.humidity;
  const uv = hourObj.uv || 0;
  const pressure = Math.round(hourObj.pressure_mb);

  return {
    temp,
    feelsLike,
    wind,
    humidity,
    uv,
    pressure,
    precip,
    outfit: getOutfitRecommendation(temp, feelsLike, precip, wind, uv, pressure)
  };
}

async function generateWeatherReport(user) {
  const result = await getWeatherForecast(user.city_name);
  if (result.error) return `⚠️ ${result.error}`;

  const data = result.data;
  const hours = data.forecast.forecastday[0].hour;

  const morning = parseHourData(hours[8]);
  const day = parseHourData(hours[14]);
  const evening = parseHourData(hours[19]);
  const night = parseHourData(hours[23]);

  const dateStr = new Date().toLocaleDateString('ru-RU', {
    timeZone: user.timezone || 'UTC',
    day: 'numeric',
    month: 'long',
    weekday: 'short'
  });

  return (
    `📍 *${data.location.name}* — Прогноз на сегодня (${dateStr})\n\n` +
    `🌅 *Утро (08:00):* ${morning.temp}°C (ощущается ${morning.feelsLike}°C)\n` +
    `💧 Влажность: ${morning.humidity}% | 💨 Ветер: ${morning.wind} м/с\n` +
    `💡 ${morning.outfit}\n\n` +

    `☀️ *День (14:00):* ${day.temp}°C (ощущается ${day.feelsLike}°C)\n` +
    `💧 Влажность: ${day.humidity}% | 💨 Ветер: ${day.wind} м/с | ☀️ УФ: ${day.uv}\n` +
    `💡 ${day.outfit}\n\n` +

    `🌆 *Вечер (19:00):* ${evening.temp}°C (ощущается ${evening.feelsLike}°C)\n` +
    `💧 Влажность: ${evening.humidity}% | 💨 Ветер: ${evening.wind} м/с\n` +
    `💡 ${evening.outfit}\n\n` +

    `🌙 *Ночь (23:00):* ${night.temp}°C (ощущается ${night.feelsLike}°C)\n` +
    `💡 ${night.outfit}\n\n` +
    `👇 *Выберите час для подробностей:*`
  );
}

// Команда /start
bot.command('start', async (ctx) => {
  const chatId = ctx.chat.id;
  userState.set(chatId, { step: 'WAITING_CITY' });

  await ctx.reply(
    'Привет! 👋 Я бот «Погода & Гардероб 24/7».\n\n' +
    'Введи название своего города (например, *Москва* или *Тирасполь*):',
    { parse_mode: 'Markdown' }
  );
});

// Админ-команда /stats
bot.command('stats', async (ctx) => {
  if (ctx.chat.id !== ADMIN_ID) return;

  const { data: users, error } = await supabase.from('users').select('*');
  if (error || !users) return ctx.reply('Ошибка получения статистики из базы.');

  const totalUsers = users.length;
  const activeSubscribers = users.filter(u => u.notification_time).length;
  
  const citiesMap = {};
  users.forEach(u => {
    citiesMap[u.city_name] = (citiesMap[u.city_name] || 0) + 1;
  });

  const topCities = Object.entries(citiesMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([city, count]) => `• ${city}: ${count}`)
    .join('\n');

  return ctx.reply(
    `📊 *Статистика бота:*\n\n` +
    `👤 Всего пользователей: *${totalUsers}*\n` +
    `🔔 Активных подписок: *${activeSubscribers}*\n\n` +
    `🏙 *Популярные города:*\n${topCities || 'Нет данных'}`,
    { parse_mode: 'Markdown' }
  );
});

// Обработка кликов по Inline-кнопкам часов
bot.callbackQuery(/^hour_(\d+)$/, async (ctx) => {
  const hour = parseInt(ctx.match[1]);
  const chatId = ctx.chat.id;

  const { data: user } = await supabase.from('users').select('*').eq('telegram_id', chatId).single();
  if (!user) return ctx.answerCallbackQuery({ text: 'Пользователь не найден' });

  const result = await getWeatherForecast(user.city_name);
  if (result.error) return ctx.answerCallbackQuery({ text: 'Ошибка API погоды' });

  const hourData = parseHourData(result.data.forecast.forecastday[0].hour[hour]);

  await ctx.answerCallbackQuery();
  await ctx.reply(
    `🕒 *Прогноз на ${hour}:00 в ${user.city_name}:*\n\n` +
    `🌡 Температура: *${hourData.temp}°C* (ощущается как ${hourData.feelsLike}°C)\n` +
    `💧 Влажность: *${hourData.humidity}%*\n` +
    `💨 Ветер: *${hourData.wind} м/с*\n` +
    `📊 Давление: *${hourData.pressure} hPa*\n` +
    `☀️ Индекс УФ: *${hourData.uv}*\n\n` +
    `💡 ${hourData.outfit}`,
    { parse_mode: 'Markdown' }
  );
});

// Обработка текстовых сообщений
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
    return ctx.reply(report, { parse_mode: 'Markdown', reply_markup: hoursInlineKeyboard });
  }

  if (text === '⚙️ Изменить город / время') {
    userState.set(chatId, { step: 'WAITING_CITY' });
    return ctx.reply('Введите новое название вашего города:');
  }

  if (text === '🔕 Отключить рассылку') {
    await supabase.from('users').update({ notification_time: null }).eq('telegram_id', chatId);
    return ctx.reply('🔕 Ежедневная рассылка отключена.', { reply_markup: mainKeyboard });
  }

  if (state.step === 'WAITING_CITY') {
    const weatherResult = await getWeatherForecast(text);
    if (weatherResult.error || !weatherResult.data?.location) {
      return ctx.reply(`❌ Город не найден.`);
    }

    const weatherData = weatherResult.data;
    userState.set(chatId, {
      step: 'WAITING_TIME',
      cityData: {
        name: weatherData.location.name,
        lat: weatherData.location.lat,
        lon: weatherData.location.lon,
        timezone: weatherData.location.tz_id
      }
    });

    return ctx.reply(
      `Город *${weatherData.location.name}* найден! ✅\n\n` +
      `Введите время утреннего отчета (в формате *ЧЧ:ММ*, например \`07:30\`):`,
      { parse_mode: 'Markdown' }
    );
  }

  if (state.step === 'WAITING_TIME') {
    const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
    if (!timeRegex.test(text)) {
      return ctx.reply('❌ Неверный формат времени. Используйте формат *ЧЧ:ММ*:');
    }

    const { cityData } = state;
    await supabase.from('users').upsert({
      telegram_id: chatId,
      city_name: cityData.name,
      latitude: cityData.lat,
      longitude: cityData.lon,
      timezone: cityData.timezone,
      notification_time: text
    });

    userState.delete(chatId);
    return ctx.reply(`Отлично! Всё настроено 🎉`, { reply_markup: mainKeyboard });
  }
});

// Крон-рассылка утренних отчетов (каждую минуту)
cron.schedule('* * * * *', async () => {
  try {
    const { data: users } = await supabase.from('users').select('*');
    if (!users) return;

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
          reply_markup: hoursInlineKeyboard
        }).catch(() => {});
      }
    }
  } catch (err) {
    console.error('Ошибка Cron:', err);
  }
});

// Крон для штормовых предупреждений (раз в час в :00 минут)
cron.schedule('0 * * * *', async () => {
  try {
    const { data: users } = await supabase.from('users').select('*');
    if (!users) return;

    for (const user of users) {
      const result = await getWeatherForecast(user.city_name);
      if (result.error) continue;

      const current = result.data.current;
      const windSpeed = Math.round(current.wind_kph / 3.6);

      // Проверка на штормовой ветер (> 15 м/с)
      if (windSpeed >= 15) {
        await bot.api.sendMessage(
          user.telegram_id,
          `⚠️ *ШТОРМОВОЕ ПРЕДУПРЕЖДЕНИЕ* в ${user.city_name}!\n\n` +
          `💨 Порывы ветра достигают *${windSpeed} м/с*.\n` +
          `Будьте осторожны на улице и держитесь подальше от высоких деревьев и рекламных щитов!`,
          { parse_mode: 'Markdown' }
        ).catch(() => {});
      }
    }
  } catch (err) {
    console.error('Ошибка проверки штормов:', err);
  }
});

// Веб-сервер для поддержания активности на Render
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is running online!');
}).listen(PORT, () => console.log(`Веб-сервер запущен на порту ${PORT}`));

bot.start({
  onStart: () => console.log('🤖 Бот успешно запущен со всеми новыми функциями!')
});
