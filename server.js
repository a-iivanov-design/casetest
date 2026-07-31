const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let db;

async function initDb() {
    db = await open({
        filename: path.join(__dirname, 'database.db'),
        driver: sqlite3.Database
    });

    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT,
            is_banned INTEGER DEFAULT 0,
            last_spin TEXT
        );
        CREATE TABLE IF NOT EXISTS admins (
            user_id TEXT,
            username TEXT,
            is_admin INTEGER DEFAULT 1,
            is_super INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS prizes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            icon TEXT,
            rarity TEXT,
            weight INTEGER,
            promo_prefix TEXT
        );
        CREATE TABLE IF NOT EXISTS inventory (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT,
            prize_name TEXT,
            icon TEXT,
            promo TEXT,
            won_at TEXT
        );
    `);

    // Создаем дефолтного супер-админа, если таблица пуста
    const adminCount = await db.get(`SELECT COUNT(*) as cnt FROM admins`);
    if (adminCount.cnt === 0) {
        await db.run(`INSERT INTO admins (user_id, username, is_admin, is_super) VALUES (?, ?, 1, 1)`, ['12345', 'ropogku']);
    }
}
initDb();

// Вспомогательная функция проверки админа
async function checkIsAdmin(userId, username) {
    const cleanUsername = username ? username.replace('@', '').trim() : '';
    const admin = await db.get(
        `SELECT * FROM admins WHERE user_id = ? OR LOWER(username) = LOWER(?)`,
        [userId, cleanUsername]
    );
    return admin;
}

// Проверка статуса пользователя (бан + кулдаун)
app.get('/api/status', async (req, res) => {
    try {
        const { userId, username } = req.query;
        if (!userId) return res.status(400).json({ error: 'No userId' });

        let user = await db.get(`SELECT * FROM users WHERE id = ?`, [userId]);
        const cleanUsername = username || '';

        if (!user) {
            await db.run(`INSERT INTO users (id, username, is_banned) VALUES (?, ?, 0)`, [userId, cleanUsername]);
            user = { id: userId, username: cleanUsername, is_banned: 0, last_spin: null };
        } else if (cleanUsername && user.username !== cleanUsername) {
            await db.run(`UPDATE users SET username = ? WHERE id = ?`, [cleanUsername, userId]);
        }

        if (user.is_banned === 1) {
            return res.json({ isBanned: true });
        }

        if (!user.last_spin) {
            return res.json({ isBanned: false, canSpin: true });
        }

        const lastSpinTime = new Date(user.last_spin).getTime();
        const now = Date.now();
        const diffHours = (now - lastSpinTime) / (1000 * 60 * 60);

        if (diffHours < 24) {
            const hoursLeft = Math.ceil(24 - diffHours);
            return res.json({ isBanned: false, canSpin: false, hoursLeft });
        }

        res.json({ isBanned: false, canSpin: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Server error' });
    }
});

// Проверка прав администратора
app.get('/api/admin/check', async (req, res) => {
    try {
        const { userId, username } = req.query;
        const admin = await checkIsAdmin(userId, username);
        if (admin) {
            res.json({ isAdmin: true, isSuper: Boolean(admin.is_super) });
        } else {
            res.json({ isAdmin: false });
        }
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Открытие кейса (розыгрыш)
app.post('/api/spin', async (req, res) => {
    try {
        const { userId, username } = req.body;
        if (!userId) return res.status(400).json({ error: 'No userId' });

        let user = await db.get(`SELECT * FROM users WHERE id = ?`, [userId]);
        const cleanUsername = username || '';

        if (!user) {
            await db.run(`INSERT INTO users (id, username, is_banned) VALUES (?, ?, 0)`, [userId, cleanUsername]);
            user = { id: userId, username: cleanUsername, is_banned: 0, last_spin: null };
        }

        if (user.is_banned === 1) return res.status(403).json({ error: 'Аккаунт заблокирован' });

        if (user.last_spin) {
            const lastSpinTime = new Date(user.last_spin).getTime();
            const diffHours = (Date.now() - lastSpinTime) / (1000 * 60 * 60);
            if (diffHours < 24) {
                return res.status(400).json({ error: 'Кейс уже открывался сегодня' });
            }
        }

        const prizes = await db.all(`SELECT * FROM prizes`);
        if (!prizes || prizes.length === 0) {
            return res.status(500).json({ error: 'В базе нет призов для кейса' });
        }

        let totalWeight = prizes.reduce((sum, p) => sum + p.weight, 0);
        let randomWeight = Math.random() * totalWeight;
        let currentWeight = 0;
        let wonPrize = prizes[0];

        for (const p of prizes) {
            currentWeight += p.weight;
            if (randomWeight <= currentWeight) {
                wonPrize = p;
                break;
            }
        }

        const nowIso = new Date().toISOString();
        await db.run(`UPDATE users SET last_spin = ? WHERE id = ?`, [nowIso, userId]);

        const promo = (wonPrize.promo_prefix || 'PROMO') + '-' + Math.random().toString(36).substring(2, 8).toUpperCase();
        
        await db.run(
            `INSERT INTO inventory (user_id, prize_name, icon, promo, won_at) VALUES (?, ?, ?, ?, ?)`,
            [userId, wonPrize.name, wonPrize.icon, promo, nowIso]
        );

        res.json({
            prize: { name: wonPrize.name, icon: wonPrize.icon, rarity: wonPrize.rarity },
            promo: promo
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Server error during spin' });
    }
});

// Инвентарь пользователя
app.get('/api/inventory', async (req, res) => {
    try {
        const { userId } = req.query;
        if (!userId) return res.status(400).json({ error: 'No userId' });

        const items = await db.all(`SELECT * FROM inventory WHERE user_id = ? ORDER BY id DESC`, [userId]);
        res.json({ items });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Список всех призов для админки
app.get('/api/admin/prizes', async (req, res) => {
    try {
        const { userId, username } = req.query;
        const admin = await checkIsAdmin(userId, username);
        if (!admin) return res.status(403).json({ error: 'Нет доступа' });

        const prizes = await db.all(`SELECT * FROM prizes`);
        res.json({ prizes });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Добавление приза
app.post('/api/admin/add-prize', async (req, res) => {
    try {
        const { userId, username, name, icon, rarity, weight, promo_prefix } = req.body;
        const admin = await checkIsAdmin(userId, username);
        if (!admin) return res.status(403).json({ error: 'Нет доступа' });

        await db.run(
            `INSERT INTO prizes (name, icon, rarity, weight, promo_prefix) VALUES (?, ?, ?, ?, ?)`,
            [name, icon || '🎁', rarity || 'common', Number(weight) || 10, promo_prefix || 'CYBER']
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка при добавлении приза' });
    }
});

// Удаление приза
app.post('/api/admin/delete-prize', async (req, res) => {
    try {
        const { userId, username, prizeId } = req.body;
        const admin = await checkIsAdmin(userId, username);
        if (!admin) return res.status(403).json({ error: 'Нет доступа' });

        await db.run(`DELETE FROM prizes WHERE id = ?`, [prizeId]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка при удалении' });
    }
});

// Обновление веса (шанса) приза
app.post('/api/admin/update-prize', async (req, res) => {
    try {
        const { userId, username, prizeId, weight } = req.body;
        const admin = await checkIsAdmin(userId, username);
        if (!admin) return res.status(403).json({ error: 'Нет доступа' });

        await db.run(`UPDATE prizes SET weight = ? WHERE id = ?`, [Number(weight), prizeId]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка обновления' });
    }
});

// Статистика для админки
app.get('/api/admin/stats', async (req, res) => {
    try {
        const { userId, username } = req.query;
        const admin = await checkIsAdmin(userId, username);
        if (!admin) return res.status(403).json({ error: 'Нет доступа' });

        const totalSpins = await db.get(`SELECT COUNT(*) as cnt FROM inventory`);
        const totalUsers = await db.get(`SELECT COUNT(*) as cnt FROM users`);
        const bannedUsers = await db.get(`SELECT COUNT(*) as cnt FROM users WHERE is_banned = 1`);

        res.json({
            totalSpins: totalSpins.cnt,
            totalUsers: totalUsers.cnt,
            bannedUsers: bannedUsers.cnt
        });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Список забаненных
app.get('/api/admin/banned-list', async (req, res) => {
    try {
        const { userId, username } = req.query;
        const admin = await checkIsAdmin(userId, username);
        if (!admin) return res.status(403).json({ error: 'Нет доступа' });

        const bannedUsers = await db.all(`SELECT id, username FROM users WHERE is_banned = 1`);
        res.json({ bannedUsers });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Список всех пользователей
app.get('/api/admin/users-list', async (req, res) => {
    try {
        const { userId, username } = req.query;
        const admin = await checkIsAdmin(userId, username);
        if (!admin) return res.status(403).json({ error: 'Нет доступа' });

        const users = await db.all(`SELECT id, username, is_banned, last_spin FROM users ORDER BY username ASC`);
        res.json({ users });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Блокировка / разблокировка
app.post('/api/admin/ban', async (req, res) => {
    try {
        const { userId, username, targetUsername, banState } = req.body;
        const admin = await checkIsAdmin(userId, username);
        if (!admin) return res.status(403).json({ error: 'Нет доступа' });

        const cleanTarget = targetUsername.replace('@', '').trim();
        const result = await db.run(
            `UPDATE users SET is_banned = ? WHERE LOWER(username) = LOWER(?) OR id = ?`,
            [banState, cleanTarget, cleanTarget]
        );

        if (result.changes === 0) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Сброс кулдауна таймера
app.post('/api/admin/reset-timer', async (req, res) => {
    try {
        const { userId, username, targetUsername } = req.body;
        const admin = await checkIsAdmin(userId, username);
        if (!admin) return res.status(403).json({ error: 'Нет доступа' });

        const cleanTarget = targetUsername.replace('@', '').trim();
        const result = await db.run(
            `UPDATE users SET last_spin = NULL WHERE LOWER(username) = LOWER(?) OR id = ?`, 
            [cleanTarget, cleanTarget]
        );

        if (result.changes === 0) {
            return res.status(404).json({ error: 'Пользователь не найден в базе' });
        }

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка сервера при сбросе таймера' });
    }
});

// Список администраторов
app.get('/api/admin/list', async (req, res) => {
    try {
        const { userId, username } = req.query;
        const admin = await checkIsAdmin(userId, username);
        if (!admin) return res.status(403).json({ error: 'Нет доступа' });

        const admins = await db.all(`SELECT username, is_super FROM admins`);
        res.json({ admins });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Добавление администратора
app.post('/api/admin/add-admin', async (req, res) => {
    try {
        const { userId, username, newAdminUsername } = req.body;
        const admin = await checkIsAdmin(userId, username);
        if (!admin || !admin.is_super) return res.status(403).json({ error: 'Недостаточно прав' });

        const cleanTarget = newAdminUsername.replace('@', '').trim();
        await db.run(
            `INSERT INTO admins (user_id, username, is_admin, is_super) VALUES (?, ?, 1, 0)`,
            ['external_' + cleanTarget, cleanTarget]
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка при добавлении администратора (возможно, он уже существует)' });
    }
});

// Удаление администратора
app.post('/api/admin/remove-admin', async (req, res) => {
    try {
        const { userId, username, targetAdminUsername } = req.body;
        const admin = await checkIsAdmin(userId, username);
        if (!admin || !admin.is_super) return res.status(403).json({ error: 'Недостаточно прав' });

        const cleanTarget = targetAdminUsername.replace('@', '').trim();
        await db.run(`DELETE FROM admins WHERE LOWER(username) = LOWER(?)`, [cleanTarget]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка при удалении администратора' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
