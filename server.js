const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@libsql/client');

const app = express();
app.use(express.json());
app.use(cors());

app.use(express.static(path.join(__dirname, 'public')));

const db = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
});

async function initDB() {
    try {
        // ВНИМАНИЕ: Убраны команды DROP TABLE, чтобы при перезапуске/деплое 
        // на Render данные в базе данных Turso больше никогда не стирались!
        
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
                is_super INTEGER DEFAULT 0
            )
        `);

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

        await db.execute({
            sql: "INSERT OR IGNORE INTO admins (username, is_super) VALUES (?, ?)",
            args: ['ropogku', 1]
        });

        console.log('База данных успешно инициализирована (данные сохранены).');
    } catch (err) {
        console.error('Ошибка инициализации БД:', err);
    }
}
initDB();

async function checkAdmin(userId, username) {
    if (!username) return { isAdmin: false, isSuper: false };
    const cleanUsername = username.replace('@', '').toLowerCase();
    
    if (cleanUsername === 'ropogku') {
        return { isAdmin: true, isSuper: true };
    }

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
        if (user.banned === 1) return res.json({ isBanned: true });
        if (!user.last_spin) return res.json({ isBanned: false, canSpin: true });

        const diffHours = (new Date() - new Date(user.last_spin)) / (1000 * 60 * 60);
        if (diffHours < 24) {
            return res.json({ isBanned: false, canSpin: false, hoursLeft: Math.ceil(24 - diffHours) });
        }

        res.json({ isBanned: false, canSpin: true });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.get('/api/admin/check', async (req, res) => {
    try {
        const { userId, username } = req.query;
        res.json(await checkAdmin(userId, username));
    } catch (e) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.get('/api/inventory', async (req, res) => {
    try {
        const { userId } = req.query;
        const result = await db.execute({
            sql: "SELECT * FROM inventory WHERE user_id = ? ORDER BY won_at DESC",
            args: [userId]
        });

        const now = new Date();
        const items = [];

        for (const item of result.rows) {
            if ((now - new Date(item.won_at)) / (1000 * 60 * 60) > 48) {
                await db.execute({ sql: "DELETE FROM inventory WHERE id = ?", args: [item.id] });
            } else {
                items.push({ ...item, isExpired: false });
            }
        }
        res.json({ items });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.post('/api/spin', async (req, res) => {
    try {
        const { userId, username } = req.body;
        let userRes = await db.execute({ sql: "SELECT * FROM users WHERE user_id = ?", args: [userId] });

        if (userRes.rows.length > 0 && userRes.rows[0].banned === 1) {
            return res.status(403).json({ error: 'Вы заблокированы!' });
        }
        if (userRes.rows.length > 0 && userRes.rows[0].last_spin) {
            if ((new Date() - new Date(userRes.rows[0].last_spin)) / (1000 * 60 * 60) < 24) {
                return res.status(400).json({ error: 'Кейс можно открывать раз в 24 часа!' });
            }
        }

        const prizes = (await db.execute("SELECT * FROM prizes")).rows;
        if (prizes.length === 0) return res.status(500).json({ error: 'Призы не настроены' });

        let totalWeight = prizes.reduce((sum, p) => sum + p.weight, 0);
        let randomWeight = Math.random() * totalWeight;
        let selectedPrize = prizes[0];

        for (let p of prizes) {
            if (randomWeight < p.weight) { selectedPrize = p; break; }
            randomWeight -= p.weight;
        }

        const promoCode = `${selectedPrize.promo_prefix || 'CYBER'}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
        const nowIso = new Date().toISOString();

        await db.execute({
            sql: "INSERT INTO inventory (user_id, prize_name, icon, promo, won_at) VALUES (?, ?, ?, ?, ?)",
            args: [userId, selectedPrize.name, selectedPrize.icon, promoCode, nowIso]
        });

        await db.execute({
            sql: `INSERT INTO users (user_id, username, banned, last_spin) VALUES (?, ?, 0, ?) 
                  ON CONFLICT(user_id) DO UPDATE SET last_spin = ?, username = ?`,
            args: [userId, username || '', nowIso, nowIso, username || '']
        });

        res.json({ prize: { name: selectedPrize.name, icon: selectedPrize.icon, rarity: selectedPrize.rarity }, promo: promoCode });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.get('/api/admin/prizes', async (req, res) => {
    try {
        const admin = await checkAdmin(req.query.userId, req.query.username);
        if (!admin.isAdmin) return res.status(403).json({ error: 'Доступ запрещен' });
        res.json({ prizes: (await db.execute("SELECT * FROM prizes")).rows });
    } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/admin/update-prize', async (req, res) => {
    try {
        const { userId, username, prizeId, weight } = req.body;
        if (!(await checkAdmin(userId, username)).isAdmin) return res.status(403).json({ error: 'Доступ запрещен' });
        await db.execute({ sql: "UPDATE prizes SET weight = ? WHERE id = ?", args: [weight, prizeId] });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/admin/add-prize', async (req, res) => {
    try {
        const { userId, username, name, icon, rarity, weight, promo_prefix } = req.body;
        if (!(await checkAdmin(userId, username)).isAdmin) return res.status(403).json({ error: 'Доступ запрещен' });
        await db.execute({
            sql: "INSERT INTO prizes (name, icon, rarity, weight, promo_prefix) VALUES (?, ?, ?, ?, ?)",
            args: [name, icon || '🎁', rarity || 'common', weight || 10, promo_prefix || 'PROMO']
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/admin/delete-prize', async (req, res) => {
    try {
        const { userId, username, prizeId } = req.body;
        if (!(await checkAdmin(userId, username)).isAdmin) return res.status(403).json({ error: 'Доступ запрещен' });
        await db.execute({ sql: "DELETE FROM prizes WHERE id = ?", args: [prizeId] });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/admin/stats', async (req, res) => {
    try {
        if (!(await checkAdmin(req.query.userId, req.query.username)).isAdmin) return res.status(403).json({ error: 'Доступ запрещен' });
        res.json({
            totalSpins: (await db.execute("SELECT COUNT(*) as count FROM inventory")).rows[0].count,
            totalUsers: (await db.execute("SELECT COUNT(*) as count FROM users")).rows[0].count,
            bannedUsers: (await db.execute("SELECT COUNT(*) as count FROM users WHERE banned = 1")).rows[0].count
        });
    } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/admin/ban', async (req, res) => {
    try {
        const { userId, username, targetUsername, banState } = req.body;
        if (!(await checkAdmin(userId, username)).isAdmin) return res.status(403).json({ error: 'Доступ запрещен' });
        const cleanTarget = targetUsername.replace('@', '').toLowerCase();
        
        const check = await db.execute({ sql: "SELECT * FROM users WHERE LOWER(username) = ?", args: [cleanTarget] });
        if (check.rows.length === 0) {
            await db.execute({ sql: "INSERT INTO users (user_id, username, banned, last_spin) VALUES (?, ?, ?, NULL)", args: ['manual_' + cleanTarget, cleanTarget, banState] });
        } else {
            await db.execute({ sql: "UPDATE users SET banned = ? WHERE LOWER(username) = ?", args: [banState, cleanTarget] });
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

// Получить список активных администраторов
app.get('/api/admin/list', async (req, res) => {
    try {
        const { userId, username } = req.query;
        const adminCheck = await checkAdmin(userId, username);
        if (!adminCheck.isAdmin) return res.status(403).json({ error: 'Доступ запрещен' });

        const result = await db.execute("SELECT username, is_super FROM admins");
        res.json({ admins: result.rows });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// НОВОЕ: Получить список забаненных пользователей
app.get('/api/admin/banned-list', async (req, res) => {
    try {
        const { userId, username } = req.query;
        const adminCheck = await checkAdmin(userId, username);
        if (!adminCheck.isAdmin) return res.status(403).json({ error: 'Доступ запрещен' });

        const result = await db.execute("SELECT username, user_id FROM users WHERE banned = 1");
        res.json({ bannedUsers: result.rows });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Добавить админа по юзернейму
app.post('/api/admin/add-admin', async (req, res) => {
    try {
        const { userId, username, newAdminUsername } = req.body;
        const adminCheck = await checkAdmin(userId, username);
        if (!adminCheck.isSuper) return res.status(403).json({ error: 'Нужен супер-админ' });

        if (!newAdminUsername) {
            return res.status(400).json({ error: 'Укажите юзернейм администратора' });
        }

        const cleanNewAdmin = newAdminUsername.replace('@', '').trim().toLowerCase();
        
        await db.execute({ 
            sql: "INSERT INTO admins (username, is_super) VALUES (?, 0) ON CONFLICT(username) DO UPDATE SET is_super = 0", 
            args: [cleanNewAdmin] 
        });

        res.json({ success: true });
    } catch (e) { 
        console.error(e);
        res.status(500).json({ error: 'Ошибка сервера' }); 
    }
});

// Разжаловать админа
app.post('/api/admin/remove-admin', async (req, res) => {
    try {
        const { userId, username, targetAdminUsername } = req.body;
        const adminCheck = await checkAdmin(userId, username);
        if (!adminCheck.isSuper) return res.status(403).json({ error: 'Нужен супер-админ' });

        const cleanTarget = targetAdminUsername.replace('@', '').trim().toLowerCase();
        if (cleanTarget === 'ropogku') {
            return res.status(400).json({ error: 'Нельзя разжаловать главного админа!' });
        }

        await db.execute({ sql: "DELETE FROM admins WHERE LOWER(username) = ?", args: [cleanTarget] });
        res.json({ success: true });
    } catch (e) { 
        console.error(e);
        res.status(500).json({ error: 'Ошибка сервера' }); 
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`Сервер запущен на порту ${PORT}`); });
