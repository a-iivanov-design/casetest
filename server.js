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

    // Создание таблиц при необходимости
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
}
initDb();

// Вспомогательная функция проверки админа
async function checkIsAdmin(userId, username) {
    const admin = await db.get(
        `SELECT * FROM admins WHERE user_id = ? OR LOWER(username) = LOWER(?)`,
        [userId, username ? username.replace('@', '') : '']
    );
    return admin;
}

// Проверка статуса пользователя (бан + кулдаун кейса)
app.get('/api/status', async (req, res) => {
    const { userId, username } = req.query;
    if (!userId) return res.status(400).json({ error: 'No userId' });

    let user = await db.get(`SELECT * FROM users WHERE id = ?`, [userId]);
    if (!user) {
        await db.run(`INSERT INTO users (id, username, is_banned) VALUES (?, ?, 0)`, [userId, username || '']);
        user = { id: userId, username: username || '', is_banned: 0, last_spin: null };
    } else if (username && user.username !== username) {
        await db.run(`UPDATE users SET username = ? WHERE id = ?`, [username, userId]);
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
});

// Проверка прав администратора для фронтенда
app.get('/api/admin/check', async (req, res) => {
    const { userId, username } = req.query;
    const admin = await checkIsAdmin(userId, username);
    if (admin) {
        res.json({ isAdmin: true, isSuper: Boolean(admin.is_super) });
    } else {
        res.json({ isAdmin: false });
    }
});

// Получение списка всех пользователей (для админки)
app.get('/api/admin/users-list', async (req, res) => {
    const { userId, username } = req.query;
    const admin = await checkIsAdmin(userId, username);
    if (!admin) return res.status(403).json({ error: 'Нет доступа' });

    try {
        const users = await db.all(`SELECT id, username, is_banned, last_spin FROM users ORDER BY username ASC`);
        res.json({ users });
    } catch (e) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Блокировка / разблокировка пользователя
app.post('/api/admin/ban', async (req, res) => {
    const { userId, username, targetUsername, banState } = req.body;
    const admin = await checkIsAdmin(userId, username);
    if (!admin) return res.status(403).json({ error: 'Нет доступа' });

    const cleanTarget = targetUsername.replace('@', '').trim();
    const result = await db.run(
        `UPDATE users SET is_banned = ? WHERE username = ? OR id = ?`,
        [banState, cleanTarget, cleanTarget]
    );

    if (result.changes === 0) {
        return res.status(404).json({ error: 'Пользователь не найден' });
    }

    res.json({ success: true });
});

// Сброс таймера ежедневного кейса для пользователя
app.post('/api/admin/reset-timer', async (req, res) => {
    const { userId, username, targetUsername } = req.body;
    const admin = await checkIsAdmin(userId, username);
    if (!admin) return res.status(403).json({ error: 'Нет доступа' });

    try {
        const cleanTarget = targetUsername.replace('@', '').trim();
        const result = await db.run(
            `UPDATE users SET last_spin = NULL WHERE username = ? OR id = ?`, 
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

// Остальные ваши маршруты (призы, инвентарь, спин и т.д.) продолжают работать здесь...

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
