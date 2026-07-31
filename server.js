const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const path = require('path');

// Твой токен от BotFather
const token = '8857734278:AAGc81Hq1BN4M6soN59OKRl31zDaHol5flA';

// Создаем бота (режим polling для локальной разработки или работы)
const bot = new TelegramBot(token, { polling: true });
const app = express();

app.use(express.json());
// Раздаем статические файлы (нашу HTML-игру) из папки public
app.use(express.static(path.join(__dirname, 'public')));

// Список призов (должен совпадать с фронтендом)
const prizes = [
    { name: '30 мин', icon: '⏳', rarity: 'common', weight: 50 },
    { name: '1 час', icon: '⏰', rarity: 'uncommon', weight: 30 },
    { name: 'Энергетик', icon: '⚡', rarity: 'uncommon', weight: 15 },
    { name: '3 часа', icon: '🎮', rarity: 'rare', weight: 4 },
    { name: 'Ночной пакет', icon: '🌙', rarity: 'epic', weight: 1 }
];

// API-эндпоинт: когда пользователь нажимает кнопку в игре, сервер крутит рулетку
app.post('/api/spin', (req, res) => {
    const { userId } = req.body;
    
    // Здесь в будущем можно проверять, крутил ли уже пользователь сегодня (по ID)
    
    // Честный выбор приза на сервере
    const total = prizes.reduce((s, p) => s + p.weight, 0);
    let r = Math.random() * total;
    let selectedPrize = prizes[0];
    
    for (const p of prizes) {
        if (r < p.weight) {
            selectedPrize = p;
            break;
        }
        r -= p.weight;
    }

    // Генерируем уникальный промокод
    const promoCode = 'CYBER-' + Math.random().toString(36).substring(2, 8).toUpperCase();

    // Возвращаем результат клиенту
    res.json({
        success: true,
        prize: selectedPrize,
        promo: promoCode
    });
});

// Команда /start в боте
bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const userName = msg.from.first_name || 'Геймер';

    bot.sendMessage(chatId, `Привет, ${userName}! 🎮 Добро пожаловать в компьютерный клуб.\n\nИспытай удачу и выиграй игровое время или энергетик! Нажми кнопку ниже, чтобы открыть кейс:`, {
        reply_markup: {
            inline_keyboard: [
                [
                    {
                        text: '🎁 Открыть кейс',
                        // Ссылка пока локальная, потом заменим на адрес сервера в интернете
                        web_app: { url: 'https://google.com' } 
                    }
                ]
            ]
        }
    });
});

// Запуск сервера Express
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
