const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 10000;

// Middleware для чтения JSON
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Инициализация базы данных SQLite
const dbFile = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) {
        console.error('Ошибка подключения к базе данных', err.message);
    } else {
        console.log('Подключено к базе данных SQLite.');
        initDatabase();
    }
});

// Создание таблиц и заполнение базовыми призами для клуба по умолчанию
function initDatabase() {
    db.serialize(() => {
        // Таблица пользователей
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            club_id TEXT DEFAULT 'default_club',
            has_spun INTEGER DEFAULT 0
        )`);

        // Таблица призов с шансами (weight)
        db.run(`CREATE TABLE IF NOT EXISTS prizes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            club_id TEXT DEFAULT 'default_club',
            name TEXT,
            icon TEXT,
            rarity TEXT,
            weight INTEGER,
            promo_prefix TEXT
        )`);

        // Таблица инвентаря выигранных призов
        db.run(`CREATE TABLE IF NOT EXISTS inventory (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT,
            prize_name TEXT,
            icon TEXT,
            rarity TEXT,
            promo TEXT,
            won_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // Проверяем, есть ли призы в базе. Если нет — добавляем стандартные
        db.get(`SELECT COUNT(*) as count FROM prizes`, (err, row) => {
            if (row.count === 0) {
                const defaultPrizes = [
                    { name: '30 мин', icon: '⏳', rarity: 'common', weight: 50, promo: 'TIME30' },
                    { name: '1 час', icon: '⏰', rarity: 'uncommon', weight: 30, promo: 'TIME60' },
                    { name: 'Энергетик', icon: '⚡', rarity: 'uncommon', weight: 15, promo: 'DRINK' },
                    { name: '3 часа', icon: '🎮', rarity: 'rare', weight: 4, promo: 'TIME180' },
                    { name: 'Ночной пакет', icon: '🌙', rarity: 'epic', weight: 1, promo: 'NIGHT' }
                ];

                const stmt = db.prepare(`INSERT INTO prizes (name, icon, rarity, weight, promo_prefix) VALUES (?, ?, ?, ?, ?)`);
                defaultPrizes.forEach(p => {
                    stmt.run(p.name, p.icon, p.rarity, p.weight, p.promo);
                });
                stmt.finalize();
                console.log('Базовые призы успешно добавлены в базу данных.');
            }
        });
    });
}

// Эндпоинт для прокрутки кейса
app.post('/api/spin', (req, res) => {
    const userId = req.body.userId || 'test_user';
    const clubId = req.body.clubId || 'default_club';

    // Проверяем, крутил ли уже пользователь кейс
    db.get(`SELECT has_spun FROM users WHERE id = ?`, [userId], (err, user) => {
        if (user && user.has_spun === 1) {
            return res.status(400).json({ error: 'Вы уже открывали этот кейс!' });
        }

        // Достаем все призы для этого клуба
        db.all(`SELECT * FROM prizes WHERE club_id = ?`, [clubId], (err, prizes) => {
            if (err || !prizes.length) {
                return res.status(500).json({ error: 'Ошибка сервера или призы не найдены' });
            }

            // Алгоритм выбора приза по весу (шансам)
            const totalWeight = prizes.reduce((sum, p) => sum + p.weight, 0);
            let randomNum = Math.random() * totalWeight;
            let winningPrize = prizes[0];

            for (const prize of prizes) {
                if (randomNum < prize.weight) {
                    winningPrize = prize;
                    break;
                }
                randomNum -= prize.weight;
            }

            const uniquePromo = `${winningPrize.promo_prefix}-${Math.floor(1000 + Math.random() * 9000)}`;

            // Сохраняем в базу, что пользователь уже открыл кейс
            db.run(`INSERT OR REPLACE INTO users (id, club_id, has_spun) VALUES (?, ?, 1)`, [userId, clubId]);

            // Записываем приз в инвентарь пользователя
            db.run(
                `INSERT INTO inventory (user_id, prize_name, icon, rarity, promo) VALUES (?, ?, ?, ?, ?)`,
                [userId, winningPrize.name, winningPrize.icon, winningPrize.rarity, uniquePromo]
            );

            // Отправляем результат клиенту
            res.json({
                prize: {
                    name: winningPrize.name,
                    icon: winningPrize.icon,
                    rarity: winningPrize.rarity
                },
                promo: uniquePromo
            });
        });
    });
});

// Эндпоинт для получения инвентаря пользователя
app.get('/api/inventory', (req, res) => {
    const userId = req.query.userId || 'test_user';

    db.all(`SELECT prize_name, icon, rarity, promo, won_at FROM inventory WHERE user_id = ? ORDER BY won_at DESC`, [userId], (err, items) => {
        if (err) {
            return res.status(500).json({ error: 'Ошибка получения инвентаря' });
        }
        res.json({ items });
    });
});

app.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
