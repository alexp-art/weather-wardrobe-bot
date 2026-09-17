import { Bot, Keyboard } from 'grammy';
import { createClient } from '@supabase/supabase-js';
import cron from 'node-cron';
import dotenv from 'dotenv';
import axios from 'axios';
import http from 'http';

dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const bot = new Bot(process.env.BOT_TOKEN);

const userState = new Map();

const mainKeyboard = new Keyboard()
  .text('🌤 Погода сейчас')
  .text('⚙️ Изменить город / время')
  .resized();

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

// Запрос прогноза через WeatherAPI
async function getWeatherForecast(cityName) {
  const apiKey = process.env.WEATHER_API_KEY;
  
  if (!apiKey) {
    return { error: 'Переменная WEATHER_API_KEY не найдена в настройках Render.' };
  }

  try {
    const url = `https://api.weatherapi.com/v1/forecast.json?key=${apiKey.trim()}&q=${encodeURIComponent(cityName)}&days=1&aqi=no&alerts=no&lang=ru`;
    const response = await axios.get(url, { timeout: 10000 });
    return { data: response.data };
  } catch (error) {
    console.error('Ошибка WeatherAPI:', error.response?.data || error.message);
    const msg = error.response?.data?.error?.message || error.message;
    return { error: `Ошибка API Погоды: ${msg}` };
  }
}

function parseHourData(hourObj) {
  const temp = Math.round(hourObj.temp_c);
  const feelsLike = Math.round(hourObj.feelslike_c);
  const precip = hourObj.chance_of_rain || 0;
  const wind = Math.round(hourObj.wind_kph / 3.6);

  return {
    temp,
    feelsLike,
    outfit: getOutfitRecommendation(temp, feelsLike, precip, wind)
  };
}

async function generateWeatherReport(user) {
  const result = await getWeatherForecast(user.city_name);
  
  if (result.error) {
    return `⚠️ ${result.error}`;
  }

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
    `💡 ${morning.outfit}\n\n` +

    `☀️ *День (14:00):* ${day.temp}°C (ощущается ${day.feelsLike}°C)\n` +
    `💡 ${day.outfit}\n\n` +

    `🌆 *Вечер (19:00):* ${evening.temp}°C (ощущается ${evening.feelsLike}°C)\n` +
    `💡 ${evening.outfit}\n\n` +

    `🌙 *Ночь (23:00):* ${night.temp}°C (ощущается ${night.feelsLike}°C)\n` +
    `💡 ${night.outfit}`
  );
}

bot.command('start', async (ctx) => {
  const chatId = ctx.chat.id;
  userState.set(chatId, { step: 'WAITING_CITY' });

  await ctx.reply(
    'Привет! 👋 Я бот «Погода & Гардероб 24/7».\n\n' +
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
    const weatherResult = await getWeatherForecast(text);

    if (weatherResult.error || !weatherResult.data?.location) {
      return ctx.reply(`❌ Не удалось найти город. Причина: ${weatherResult.error || 'Город не найден'}`);
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
      return ctx.reply('Произошла ошибка при сохранении данных.');
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

// Простой заглушечный HTTP-сервер для удовлетворения проверок Render
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is running online!');
}).listen(PORT, () => {
  console.log(`Веб-сервер запущен на порту ${PORT}`);
});

bot.start({
  onStart: () => console.log('🤖 Бот успешно запущен и слушаeт запросы!')
});
