const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@libsql/client');

const app = express();
app.use(express.json());
app.use(cors());

// Раздаем статику из папки public (туда нужно положить ваш index.html)
app.use(express.static(path.join(__dirname, 'public')));

// Подключение к базе данных Turso
const db = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
});

// Инициализация таблиц при запуске сервера
async function initDB() {
    try {
        await db.execute(`
            CREATE TABLE IF NOT EXISTS users (
                user_id TEXT PRIMARY KEY,
                username TEXT,
                banned INTEGER DEFAULT 0,
                last_spin DATETIME
            )
        `);

        await db.execute(`
            CREATE TABLE IF NOT EXISTS prizes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                icon TEXT NOT NULL,
                rarity TEXT DEFAULT 'common',
                weight INTEGER DEFAULT 10,
                promo_prefix TEXT
            )
        `);

        await db.execute(`
            CREATE TABLE IF NOT EXISTS inventory (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT,
                prize_name TEXT,
                icon TEXT,
                promo TEXT,
                won_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await db.execute(`
            CREATE TABLE IF NOT EXISTS admins (
                username TEXT PRIMARY KEY,
                club_id TEXT,
                is_super INTEGER DEFAULT 0
            )
        `);

        // Проверяем, есть ли призы, если нет — создаем дефолтные
        const prizesCount = await db.execute("SELECT COUNT(*) as count FROM prizes");
        if (prizesCount.rows[0].count === 0) {
            await db.execute({
                sql: "INSERT INTO prizes (name, icon, rarity, weight, promo_prefix) VALUES (?, ?, ?, ?, ?)",
                args: ['1 час игры', '⏱️', 'common', 50, 'TIME1H']
            });
            await db.execute({
                sql: "INSERT INTO prizes (name, icon, rarity, weight, promo_prefix) VALUES (?, ?, ?, ?, ?)",
                args: ['Энергетик', '⚡', 'uncommon', 30, 'NRG']
            });
            await db.execute({
                sql: "INSERT INTO prizes (name, icon, rarity, weight, promo_prefix) VALUES (?, ?, ?, ?, ?)",
                args: ['500 рублей на баланс', '💵', 'rare', 15, 'MONEY500']
            });
            await db.execute({
                sql: "INSERT INTO prizes (name, icon, rarity, weight, promo_prefix) VALUES (?, ?, ?, ?, ?)",
                args: ['Ночь в клубе', '🌙', 'epic', 5, 'NIGHTVIP']
            });
        }

        // Добавим супер-админа по умолчанию (измените юзернейм на свой при необходимости)
        await db.execute({
            sql: "INSERT OR IGNORE INTO admins (username, club_id, is_super) VALUES (?, ?, ?)",
            args: ['your_telegram_username', 'default_club', 1]
        });

        console.log('База данных успешно инициализирована.');
    } catch (err) {
        console.error('Ошибка инициализации БД:', err);
    }
}
initDB();

// Вспомогательная функция проверки прав администратора
async function checkAdmin(userId, username) {
    if (!username) return { isAdmin: false, isSuper: false };
    const cleanUsername = username.replace('@', '').toLowerCase();
    const result = await db.execute({
        sql: "SELECT * FROM admins WHERE LOWER(username) = ?",
        args: [cleanUsername]
    });
    if (result.rows.length > 0) {
        return {
            isAdmin: true,
            isSuper: result.rows[0].is_super === 1
        };
    }
    return { isAdmin: false, isSuper: false };
}

// 1. Проверка статуса пользователя (доступность кейса и бан)
app.get('/api/status', async (req, res) => {
    try {
        const { userId, username } = req.query;
        let userRes = await db.execute({
            sql: "SELECT * FROM users WHERE user_id = ?",
            args: [userId]
        });

        if (userRes.rows.length === 0) {
            await db.execute({
                sql: "INSERT INTO users (user_id, username, banned, last_spin) VALUES (?, ?, 0, NULL)",
                args: [userId, username || '']
            });
            return res.json({ isBanned: false, canSpin: true });
        }

        const user = userRes.rows[0];
        if (user.banned === 1) {
            return res.json({ isBanned: true });
        }

        if (!user.last_spin) {
            return res.json({ isBanned: false, canSpin: true });
        }

        const lastSpinDate = new Date(user.last_spin);
        const now = new Date();
        const diffHours = (now - lastSpinDate) / (1000 * 60 * 60);

        if (diffHours < 24) {
            const hoursLeft = Math.ceil(24 - diffHours);
            return res.json({ isBanned: false, canSpin: false, hoursLeft });
        }

        res.json({ isBanned: false, canSpin: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// 2. Проверка админ-доступа
app.get('/api/admin/check', async (req, res) => {
    try {
        const { userId, username } = req.query;
        const adminInfo = await checkAdmin(userId, username);
        res.json(adminInfo);
    } catch (e) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// 3. Получение инвентаря пользователя
app.get('/api/inventory', async (req, res) => {
    try {
        const { userId } = req.query;
        const result = await db.execute({
            sql: "SELECT * FROM inventory WHERE user_id = ? ORDER BY won_at DESC",
            args: [userId]
        });

        const now = new Date();
        const items = result.rows.map(item => {
            const wonDate = new Date(item.won_at);
            const diffDays = (now - wonDate) / (1000 * 60 * 60 * 24);
            return {
                ...item,
                isExpired: diffDays > 2
            };
        });

        res.json({ items });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// 4. Открытие кейса (спин)
app.post('/api/spin', async (req, res) => {
    try {
        const { userId, username } = req.body;

        // Проверяем бан и кулдаун
        let userRes = await db.execute({
            sql: "SELECT * FROM users WHERE user_id = ?",
            args: [userId]
        });

        if (userRes.rows.length > 0 && userRes.rows[0].banned === 1) {
            return res.status(403).json({ error: 'Вы заблокированы!' });
        }

        if (userRes.rows.length > 0 && userRes.rows[0].last_spin) {
            const lastSpin = new Date(userRes.rows[0].last_spin);
            const diffHours = (new Date() - lastSpin) / (1000 * 60 * 60);
            if (diffHours < 24) {
                return res.status(400).json({ error: 'Кейс можно открывать раз в 24 часа!' });
            }
        }

        // Получаем все призы для рулетки
        const prizesRes = await db.execute("SELECT * FROM prizes");
        const prizes = prizesRes.rows;

        if (prizes.length === 0) {
            return res.status(500).json({ error: 'Призы не настроены администратором' });
        }

        // Рандом на основе веса (шансов)
        let totalWeight = prizes.reduce((sum, p) => sum + p.weight, 0);
        let randomWeight = Math.random() * totalWeight;
        let selectedPrize = prizes[0];

        for (let p of prizes) {
            if (randomWeight < p.weight) {
                selectedPrize = p;
                break;
            }
            randomWeight -= p.weight;
        }

        // Генерируем уникальный промокод
        const promoCode = `${selectedPrize.promo_prefix || 'CYBER'}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
        const nowIso = new Date().toISOString();

        // Сохраняем в инвентарь
        await db.execute({
            sql: "INSERT INTO inventory (user_id, prize_name, icon, promo, won_at) VALUES (?, ?, ?, ?, ?)",
            args: [userId, selectedPrize.name, selectedPrize.icon, promoCode, nowIso]
        });

        // Обновляем время последнего открытия у юзера
        await db.execute({
            sql: "INSERT INTO users (user_id, username, banned, last_spin) VALUES (?, ?, 0, ?) ON CONFLICT(user_id) DO UPDATE SET last_spin = ?",
            args: [userId, username || '', nowIso, nowIso]
        });

        res.json({
            prize: {
                name: selectedPrize.name,
                icon: selectedPrize.icon,
                rarity: selectedPrize.rarity
            },
            promo: promoCode
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Ошибка при открытии кейса' });
    }
});

// --- АДМИНСКИЕ МАРШРУТЫ ---

app.get('/api/admin/prizes', async (req, res) => {
    try {
        const { userId, username } = req.query;
        const admin = await checkAdmin(userId, username);
        if (!admin.isAdmin) return res.status(403).json({ error: 'Доступ запрещен' });

        const result = await db.execute("SELECT * FROM prizes");
        res.json({ prizes: result.rows });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.post('/api/admin/update-prize', async (req, res) => {
    try {
        const { userId, username, prizeId, weight } = req.body;
        const admin = await checkAdmin(userId, username);
        if (!admin.isAdmin) return res.status(403).json({ error: 'Доступ запрещен' });

        await db.execute({
            sql: "UPDATE prizes SET weight = ? WHERE id = ?",
            args: [weight, prizeId]
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.post('/api/admin/add-prize', async (req, res) => {
    try {
        const { userId, username, name, icon, rarity, weight, promo_prefix } = req.body;
        const admin = await checkAdmin(userId, username);
        if (!admin.isAdmin) return res.status(403).json({ error: 'Доступ запрещен' });

        await db.execute({
            sql: "INSERT INTO prizes (name, icon, rarity, weight, promo_prefix) VALUES (?, ?, ?, ?, ?)",
            args: [name, icon || '🎁', rarity || 'common', weight || 10, promo_prefix || 'PROMO']
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.post('/api/admin/delete-prize', async (req, res) => {
    try {
        const { userId, username, prizeId } = req.body;
        const admin = await checkAdmin(userId, username);
        if (!admin.isAdmin) return res.status(403).json({ error: 'Доступ запрещен' });

        await db.execute({
            sql: "DELETE FROM prizes WHERE id = ?",
            args: [prizeId]
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.get('/api/admin/stats', async (req, res) => {
    try {
        const { userId, username } = req.query;
        const admin = await checkAdmin(userId, username);
        if (!admin.isAdmin) return res.status(403).json({ error: 'Доступ запрещен' });

        const totalSpinsRes = await db.execute("SELECT COUNT(*) as count FROM inventory");
        const totalUsersRes = await db.execute("SELECT COUNT(*) as count FROM users");
        const bannedUsersRes = await db.execute("SELECT COUNT(*) as count FROM users WHERE banned = 1");

        res.json({
            totalSpins: totalSpinsRes.rows[0].count,
            totalUsers: totalUsersRes.rows[0].count,
            bannedUsers: bannedUsersRes.rows[0].count
        });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.post('/api/admin/ban', async (req, res) => {
    try {
        const { userId, username, targetUsername, banState } = req.body;
        const admin = await checkAdmin(userId, username);
        if (!admin.isAdmin) return res.status(403).json({ error: 'Доступ запрещен' });

        const cleanTarget = targetUsername.replace('@', '').toLowerCase();
        const result = await db.execute({
            sql: "UPDATE users SET banned = ? WHERE LOWER(username) = ?",
            args: [banState, cleanTarget]
        });

        if (result.rowsAffected === 0) {
            return res.status(404).json({ error: 'Пользователь с таким юзернеймом не найден в базе' });
        }

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.post('/api/admin/add-admin', async (req, res) => {
    try {
        const { userId, username, newAdminUsername, clubId } = req.body;
        const admin = await checkAdmin(userId, username);
        if (!admin.isSuper) return res.status(403).json({ error: 'Недостаточно прав (нужен супер-админ)' });

        const cleanNewAdmin = newAdminUsername.replace('@', '').toLowerCase();
        await db.execute({
            sql: "INSERT INTO admins (username, club_id, is_super) VALUES (?, ?, 0) ON CONFLICT(username) DO UPDATE SET club_id = ?",
            args: [cleanNewAdmin, clubId, clubId]
        });

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
