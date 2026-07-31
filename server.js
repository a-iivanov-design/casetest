import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@libsql/client';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Подключение к Turso
const db = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
});

// Инициализация и миграция базы данных в облаке
async function initDB() {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT,
            last_spin DATETIME,
            is_banned INTEGER DEFAULT 0
        )
    `);

    // Миграция: если колонка is_banned отсутствует в старой таблице, добавляем её
    try {
        await db.execute(`ALTER TABLE users ADD COLUMN is_banned INTEGER DEFAULT 0`);
    } catch (e) {
        // Колонка уже существует, игнорируем ошибку
    }

    await db.execute(`
        CREATE TABLE IF NOT EXISTS admins (
            username TEXT PRIMARY KEY,
            is_super INTEGER DEFAULT 0
        )
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS prizes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            icon TEXT,
            rarity TEXT,
            weight INTEGER,
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
            won_at DATETIME
        )
    `);

    // Создаем дефолтного супер-админа, если список пуст
    const adminCheck = await db.execute(`SELECT COUNT(*) as count FROM admins`);
    if (adminCheck.rows[0].count === 0) {
        await db.execute({
            sql: `INSERT INTO admins (username, is_super) VALUES (?, 1)`,
            args: ['ropogku']
        });
    }

    // Добавим дефолтные призы, если таблица пуста
    const prizeCheck = await db.execute(`SELECT COUNT(*) as count FROM prizes`);
    if (prizeCheck.rows[0].count === 0) {
        const defaultPrizes = [
            ['1 час игры', '⏱️', 'common', 50, 'TIME1H'],
            ['Энергетик', '⚡', 'common', 30, 'ENERGY'],
            ['3 часа игры', '🎮', 'rare', 15, 'TIME3H'],
            ['VIP на день', '👑', 'epic', 5, 'VIP24']
        ];
        for (const p of defaultPrizes) {
            await db.execute({
                sql: `INSERT INTO prizes (name, icon, rarity, weight, promo_prefix) VALUES (?, ?, ?, ?, ?)`,
                args: p
            });
        }
    }
}

initDB().catch(err => console.error('Ошибка инициализации БД Turso:', err));

// Проверка прав администратора
async function checkIsAdmin(userId, username) {
    if (!username) return { isAdmin: false, isSuper: false };
    const cleanName = username.replace('@', '').toLowerCase();
    
    const res = await db.execute({
        sql: `SELECT * FROM admins WHERE LOWER(username) = ?`,
        args: [cleanName]
    });
    
    if (res.rows.length === 0) return { isAdmin: false, isSuper: false };
    return { isAdmin: true, isSuper: Boolean(res.rows[0].is_super) };
}

// Эндпоинты API

app.get('/api/status', async (req, res) => {
    try {
        const { userId, username } = req.query;
        if (!userId) return res.status(400).json({ error: 'Missing userId' });

        let userRes = await db.execute({
            sql: `SELECT * FROM users WHERE id = ?`,
            args: [userId]
        });

        let user = userRes.rows[0];

        if (!user) {
            await db.execute({
                sql: `INSERT INTO users (id, username, last_spin, is_banned) VALUES (?, ?, NULL, 0)`,
                args: [userId, username || '']
            });
            return res.json({ canSpin: true, isBanned: false });
        }

        if (user.is_banned) {
            return res.json({ canSpin: false, isBanned: true });
        }

        if (!user.last_spin) {
            return res.json({ canSpin: true, isBanned: false });
        }

        const lastSpinDate = new Date(user.last_spin);
        const now = new Date();
        const diffHours = (now - lastSpinDate) / (1000 * 60 * 60);

        if (diffHours < 24) {
            const hoursLeft = Math.ceil(24 - diffHours);
            return res.json({ canSpin: false, hoursLeft, isBanned: false });
        }

        res.json({ canSpin: true, isBanned: false });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/spin', async (req, res) => {
    try {
        const { userId, username } = req.query;
        const uId = userId || req.body.userId;
        const uName = username || req.body.username;

        if (!uId) return res.status(400).json({ error: 'Missing userId' });

        let userRes = await db.execute({
            sql: `SELECT * FROM users WHERE id = ?`,
            args: [uId]
        });
        let user = userRes.rows[0];

        if (user && user.is_banned) {
            return res.status(403).json({ error: 'Аккаунт заблокирован' });
        }

        if (user && user.last_spin) {
            const diffHours = (new Date() - new Date(user.last_spin)) / (1000 * 60 * 60);
            if (diffHours < 24) {
                return res.status(400).json({ error: 'Кейс уже открывали сегодня' });
            }
        }

        const prizesRes = await db.execute(`SELECT * FROM prizes`);
        const prizes = prizesRes.rows;

        if (prizes.length === 0) {
            return res.status(500).json({ error: 'Призы не настроены' });
        }

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

        const promoCode = `${selectedPrize.promo_prefix}-${Math.floor(1000 + Math.random() * 9000)}`;
        const nowIso = new Date().toISOString();

        await db.execute({
            sql: `INSERT INTO inventory (user_id, prize_name, icon, promo, won_at) VALUES (?, ?, ?, ?, ?)`,
            args: [uId, selectedPrize.name, selectedPrize.icon, promoCode, nowIso]
        });

        if (user) {
            await db.execute({
                sql: `UPDATE users SET last_spin = ?, username = ? WHERE id = ?`,
                args: [nowIso, uName || user.username, uId]
            });
        } else {
            await db.execute({
                sql: `INSERT INTO users (id, username, last_spin, is_banned) VALUES (?, ?, ?, 0)`,
                args: [uId, uName || '', nowIso]
            });
        }

        res.json({
            success: true,
            prize: selectedPrize,
            promo: promoCode
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/inventory', async (req, res) => {
    try {
        const { userId } = req.query;
        if (!userId) return res.status(400).json({ error: 'Missing userId' });

        const result = await db.execute({
            sql: `SELECT * FROM inventory WHERE user_id = ? ORDER BY won_at DESC`,
            args: [userId]
        });

        res.json({ items: result.rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/check', async (req, res) => {
    try {
        const { userId, username } = req.query;
        const status = await checkIsAdmin(userId, username);
        res.json({ isAdmin: status.isAdmin, isSuper: status.isSuper });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/prizes', async (req, res) => {
    try {
        const { userId, username } = req.query;
        const status = await checkIsAdmin(userId, username);
        if (!status.isAdmin) return res.status(403).json({ error: 'Access denied' });

        const result = await db.execute(`SELECT * FROM prizes`);
        res.json({ prizes: result.rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/update-prize', async (req, res) => {
    try {
        const { userId, username, prizeId, weight } = req.body;
        const status = await checkIsAdmin(userId, username);
        if (!status.isAdmin) return res.status(403).json({ error: 'Access denied' });

        await db.execute({
            sql: `UPDATE prizes SET weight = ? WHERE id = ?`,
            args: [weight, prizeId]
        });

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/add-prize', async (req, res) => {
    try {
        const { userId, username, name, icon, rarity, weight, promo_prefix } = req.body;
        const status = await checkIsAdmin(userId, username);
        if (!status.isAdmin) return res.status(403).json({ error: 'Access denied' });

        await db.execute({
            sql: `INSERT INTO prizes (name, icon, rarity, weight, promo_prefix) VALUES (?, ?, ?, ?, ?)`,
            args: [name, icon || '🎁', rarity || 'common', weight, promo_prefix || 'PROMO']
        });

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/delete-prize', async (req, res) => {
    try {
        const { userId, username, prizeId } = req.body;
        const status = await checkIsAdmin(userId, username);
        if (!status.isAdmin) return res.status(403).json({ error: 'Access denied' });

        await db.execute({
            sql: `DELETE FROM prizes WHERE id = ?`,
            args: [prizeId]
        });

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Статистика (поддерживаем разные ключи для фронтенда, чтобы не было undefined)
app.get('/api/admin/stats', async (req, res) => {
    try {
        const { userId, username } = req.query;
        const status = await checkIsAdmin(userId, username);
        if (!status.isAdmin) return res.status(403).json({ error: 'Access denied' });

        const spinsRes = await db.execute(`SELECT COUNT(*) as count FROM inventory`);
        const usersRes = await db.execute(`SELECT COUNT(*) as count FROM users`);
        const bannedRes = await db.execute(`SELECT COUNT(*) as count FROM users WHERE is_banned = 1`);

        const totalSpins = spinsRes.rows[0].count;
        const totalUsers = usersRes.rows[0].count;
        const bannedUsers = bannedRes.rows[0].count;

        res.json({
            totalSpins,
            totalUsers,
            bannedUsers,
            // Дублируем ключи под возможные варианты фронтенда
            spinsCount: totalSpins,
            usersCount: totalUsers,
            bannedCount: bannedUsers
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/banned-list', async (req, res) => {
    try {
        const { userId, username } = req.query;
        const status = await checkIsAdmin(userId, username);
        if (!status.isAdmin) return res.status(403).json({ error: 'Access denied' });

        const result = await db.execute(`SELECT * FROM users WHERE is_banned = 1`);
        res.json({ bannedUsers: result.rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/users-list', async (req, res) => {
    try {
        const { userId, username } = req.query;
        const status = await checkIsAdmin(userId, username);
        if (!status.isAdmin) return res.status(403).json({ error: 'Access denied' });

        const result = await db.execute(`SELECT * FROM users ORDER BY username ASC`);
        res.json({ users: result.rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/ban', async (req, res) => {
    try {
        const { userId, username, targetUsername, banState } = req.body;
        const status = await checkIsAdmin(userId, username);
        if (!status.isAdmin) return res.status(403).json({ error: 'Access denied' });

        const cleanTarget = targetUsername.replace('@', '').trim();

        await db.execute({
            sql: `UPDATE users SET is_banned = ? WHERE username = ? OR id = ?`,
            args: [banState, cleanTarget, cleanTarget]
        });

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/reset-timer', async (req, res) => {
    try {
        const { userId, username, targetUsername } = req.body;
        const status = await checkIsAdmin(userId, username);
        if (!status.isAdmin) return res.status(403).json({ error: 'Access denied' });

        const cleanTarget = targetUsername.replace('@', '').trim();

        await db.execute({
            sql: `UPDATE users SET last_spin = NULL WHERE username = ? OR id = ?`,
            args: [cleanTarget, cleanTarget]
        });

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/list', async (req, res) => {
    try {
        const { userId, username } = req.query;
        const status = await checkIsAdmin(userId, username);
        if (!status.isAdmin) return res.status(403).json({ error: 'Access denied' });

        const result = await db.execute(`SELECT * FROM admins`);
        res.json({ admins: result.rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/add-admin', async (req, res) => {
    try {
        const { userId, username, newAdminUsername } = req.body;
        const status = await checkIsAdmin(userId, username);
        if (!status.isSuper) return res.status(403).json({ error: 'Access denied (Superadmin only)' });

        const cleanNew = newAdminUsername.replace('@', '').trim().toLowerCase();

        await db.execute({
            sql: `INSERT OR IGNORE INTO admins (username, is_super) VALUES (?, 0)`,
            args: [cleanNew]
        });

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/remove-admin', async (req, res) => {
    try {
        const { userId, username, targetAdminUsername } = req.body;
        const status = await checkIsAdmin(userId, username);
        if (!status.isSuper) return res.status(403).json({ error: 'Access denied (Superadmin only)' });

        const cleanTarget = targetAdminUsername.replace('@', '').trim().toLowerCase();

        await db.execute({
            sql: `DELETE FROM admins WHERE username = ?`,
            args: [cleanTarget]
        });

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
