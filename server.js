import express from 'express';
import { createClient } from '@libsql/client';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // Убедитесь, что файлы лежат в папке public или в корне

// Подключение к Turso / SQLite
const db = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
});

async function initDb() {
    await db.execute(`CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT,
        last_spin INTEGER,
        is_banned INTEGER DEFAULT 0
    )`);

    await db.execute(`CREATE TABLE IF NOT EXISTS prizes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        description TEXT,
        icon TEXT,
        weight INTEGER,
        rarity TEXT
    )`);

    await db.execute(`CREATE TABLE IF NOT EXISTS inventory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        prize_id INTEGER,
        promo_code TEXT,
        won_at INTEGER
    )`);

    await db.execute(`CREATE TABLE IF NOT EXISTS admins (
        id TEXT PRIMARY KEY,
        is_super INTEGER DEFAULT 0
    )`);

    // Добавляем супер-админа по умолчанию (укажите ваш Telegram ID)
    await db.execute({
        sql: `INSERT OR IGNORE INTO admins (id, is_super) VALUES (?, 1)`,
        args: ["ропогку" /* или ваш числовой ID */]
    });
}
initDb();

// Эндпоинт статуса
app.get('/api/status', async (req, res) => {
    try {
        const userId = req.query.userId;
        
        // Проверяем, админ ли юзер (замените на ваш реальный Telegram ID числом)
        const superAdminId = "123456789"; // <--- Впишите сюда ваш Telegram ID
        const isAdmin = userId === superAdminId;

        let userRes = await db.execute({
            sql: `SELECT * FROM users WHERE id = ?`,
            args: [userId]
        });

        let isBanned = false;
        let hoursLeft = 0;

        if (userRes.rows.length > 0) {
            const user = userRes.rows[0];
            isBanned = user.is_banned === 1;
            if (user.last_spin) {
                const diff = Date.now() - user.last_spin;
                const hoursPassed = diff / (1000 * 60 * 60);
                if (hoursPassed < 24) {
                    hoursLeft = 24 - hoursPassed;
                }
            }
        }

        // Получаем призы
        let prizesRes = await db.execute(`SELECT * FROM prizes`);
        let prizes = prizesRes.rows;

        // Если призов в базе нет, создадим базовые для теста
        if (prizes.length === 0) {
            await db.execute(`INSERT INTO prizes (name, description, icon, weight, rarity) VALUES ('Апгрейд до VIP', 'Випка по цене общего зала', '🎮', 50, 'common')`);
            await db.execute(`INSERT INTO prizes (name, description, icon, weight, rarity) VALUES ('Скидка 10%', 'Действует на следующий визит', '%', 30, 'uncommon')`);
            let p = await db.execute(`SELECT * FROM prizes`);
            prizes = p.rows;
        }

        res.json({ isBanned, hoursLeft, isAdmin, prizes });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

// Эндпоинт инвентаря
app.get('/api/inventory', async (req, res) => {
    try {
        const userId = req.query.userId;
        const result = await db.execute({
            sql: `SELECT inventory.promo_code, inventory.won_at, prizes.name, prizes.icon 
                  FROM inventory 
                  JOIN prizes ON inventory.prize_id = prizes.id 
                  WHERE inventory.user_id = ? ORDER BY inventory.won_at DESC`,
            args: [userId]
        });
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Эндпоинт прокрутки
app.post('/api/spin', async (req, res) => {
    try {
        const { userId } = req.body;
        const now = Date.now();

        // Проверяем пользователя
        let userRes = await db.execute({ sql: `SELECT * FROM users WHERE id = ?`, args: [userId] });
        
        if (userRes.rows.length > 0) {
            const user = userRes.rows[0];
            if (user.is_banned) return res.status(403).json({ error: 'Заблокирован' });
            if (user.last_spin && (now - user.last_spin) < 24 * 60 * 60 * 1000) {
                return res.status(400).json({ error: 'Рано крутить' });
            }
        }

        // Выбираем приз по весу
        let prizesRes = await db.execute(`SELECT * FROM prizes`);
        let prizes = prizesRes.rows;
        let totalWeight = prizes.reduce((sum, p) => sum + p.weight, 0);
        let randomWeight = Math.random() * totalWeight;
        let currentWeight = 0;
        let selectedPrize = prizes[0];

        for (let p of prizes) {
            currentWeight += p.weight;
            if (randomWeight <= currentWeight) {
                selectedPrize = p;
                break;
            }
        }

        const promoCode = 'CYBER-' + Math.random().toString(36).substring(2, 8).toUpperCase();

        // Сохраняем результат
        await db.execute({
            sql: `INSERT INTO users (id, last_spin, is_banned) VALUES (?, ?, 0) ON CONFLICT(id) DO UPDATE SET last_spin = ?`,
            args: [userId, now, now]
        });

        await db.execute({
            sql: `INSERT INTO inventory (user_id, prize_id, promo_code, won_at) VALUES (?, ?, ?, ?)`,
            args: [userId, selectedPrize.id, promoCode, now]
        });

        res.json({ prize: selectedPrize, promoCode });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
