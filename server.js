import express from 'express';
import { createClient } from '@libsql/client';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

    const tables = ['users', 'inventory'];
    for (const table of tables) {
        let res = await db.execute(`PRAGMA table_info(${table})`);
        let columns = res.rows.map(col => col.name);

        if (table === 'users') {
            if (!columns.includes('last_spin')) await db.execute(`ALTER TABLE users ADD COLUMN last_spin INTEGER`);
            if (!columns.includes('is_banned')) await db.execute(`ALTER TABLE users ADD COLUMN is_banned INTEGER DEFAULT 0`);
        }
        if (table === 'inventory') {
            if (!columns.includes('prize_id')) await db.execute(`ALTER TABLE inventory ADD COLUMN prize_id INTEGER`);
            if (!columns.includes('promo_code')) await db.execute(`ALTER TABLE inventory ADD COLUMN promo_code TEXT`);
            if (!columns.includes('won_at')) await db.execute(`ALTER TABLE inventory ADD COLUMN won_at INTEGER`);
        }
    }
}
initDb();

// Впишите сюда ваш Telegram ID числом
const ADMIN_IDS = ["123456789"]; 

app.get('/api/status', async (req, res) => {
    try {
        const userId = req.query.userId;
        const isAdmin = ADMIN_IDS.includes(String(userId));

        let userRes = await db.execute({
            sql: `SELECT * FROM users WHERE id = ?`,
            args: [userId]
        });

        let isBanned = false;
        let hoursLeft = 0;
        let nextSpinTime = 0;

        if (userRes.rows.length > 0) {
            const user = userRes.rows[0];
            isBanned = user.is_banned === 1;
            if (user.last_spin) {
                const cooldown = 24 * 60 * 60 * 1000; // 24 часа
                const elapsed = Date.now() - user.last_spin;
                if (elapsed < cooldown) {
                    nextSpinTime = user.last_spin + cooldown;
                    hoursLeft = (nextSpinTime - Date.now()); // в миллисекундах для удобства таймера
                }
            }
        }

        let prizesRes = await db.execute(`SELECT * FROM prizes`);
        let prizes = prizesRes.rows;

        if (prizes.length === 0) {
            await db.execute(`INSERT INTO prizes (name, description, icon, weight, rarity) VALUES ('Апгрейд до VIP', 'Випка по цене общего зала', '🎮', 50, 'common')`);
            await db.execute(`INSERT INTO prizes (name, description, icon, weight, rarity) VALUES ('Скидка 10%', 'Действует на следующий визит', '%', 30, 'uncommon')`);
            let p = await db.execute(`SELECT * FROM prizes`);
            prizes = p.rows;
        }

        res.json({ isBanned, hoursLeft, nextSpinTime, isAdmin, prizes });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

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

app.post('/api/spin', async (req, res) => {
    try {
        const { userId } = req.body;
        const now = Date.now();

        let userRes = await db.execute({ sql: `SELECT * FROM users WHERE id = ?`, args: [userId] });
        
        if (userRes.rows.length > 0) {
            const user = userRes.rows[0];
            if (user.is_banned) return res.status(403).json({ error: 'Заблокирован' });
            if (user.last_spin && (now - user.last_spin) < 24 * 60 * 60 * 1000) {
                const timeLeft = Math.ceil((24 * 60 * 60 * 1000 - (now - user.last_spin)) / 1000);
                return res.status(400).json({ error: 'Рано крутить', timeLeft });
            }
        }

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

app.post('/api/admin/action', async (req, res) => {
    try {
        const { adminId, targetId, actionType } = req.body;
        if (!ADMIN_IDS.includes(String(adminId))) {
            return res.status(403).json({ message: 'Доступ запрещен' });
        }

        if (actionType === 'reset') {
            await db.execute({
                sql: `UPDATE users SET last_spin = NULL WHERE id = ?`,
                args: [targetId]
            });
            res.json({ message: 'Таймер успешно сброшен!' });
        } else if (actionType === 'ban') {
            let userRes = await db.execute({ sql: `SELECT is_banned FROM users WHERE id = ?`, args: [targetId] });
            let newBanState = 1;
            if (userRes.rows.length > 0 && userRes.rows[0].is_banned === 1) {
                newBanState = 0;
            }
            await db.execute({
                sql: `INSERT INTO users (id, is_banned) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET is_banned = ?`,
                args: [targetId, newBanState, newBanState]
            });
            res.json({ message: newBanState === 1 ? 'Пользователь забанен' : 'Пользователь разбанен' });
        }
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
