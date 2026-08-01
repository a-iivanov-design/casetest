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

    await db.execute(`CREATE TABLE IF NOT EXISTS admins (
        username TEXT PRIMARY KEY
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

    const tables = ['users'];
    for (const table of tables) {
        let res = await db.execute(`PRAGMA table_info(${table})`);
        let columns = res.rows.map(col => col.name);
        if (table === 'users') {
            if (!columns.includes('username')) await db.execute(`ALTER TABLE users ADD COLUMN username TEXT`);
            if (!columns.includes('last_spin')) await db.execute(`ALTER TABLE users ADD COLUMN last_spin INTEGER`);
            if (!columns.includes('is_banned')) await db.execute(`ALTER TABLE users ADD COLUMN is_banned INTEGER DEFAULT 0`);
        }
    }

    const defaultAdmin = 'ropogku';
    await db.execute({
        sql: `INSERT OR IGNORE INTO admins (username) VALUES (?)`,
        args: [defaultAdmin]
    });
}
initDb();

async function checkIsAdmin(userId, username) {
    if (!username && !userId) return false;
    let res = await db.execute(`SELECT * FROM admins`);
    const admins = res.rows.map(a => a.username.toLowerCase());
    
    if (username && admins.includes(username.toLowerCase())) return true;
    
    if (userId) {
        let userRes = await db.execute({ sql: `SELECT username FROM users WHERE id = ?`, args: [userId] });
        if (userRes.rows.length > 0 && userRes.rows[0].username) {
            if (admins.includes(userRes.rows[0].username.toLowerCase())) return true;
        }
    }
    return false;
}

app.get('/api/status', async (req, res) => {
    try {
        const userId = req.query.userId;
        const username = req.query.username || '';

        if (userId) {
            await db.execute({
                sql: `INSERT INTO users (id, username, is_banned) VALUES (?, ?, 0) ON CONFLICT(id) DO UPDATE SET username = COALESCE(?, username)`,
                args: [userId, username, username]
            });
        }

        const isAdmin = await checkIsAdmin(userId, username);

        let userRes = await db.execute({ sql: `SELECT * FROM users WHERE id = ?`, args: [userId] });
        let isBanned = false;
        let nextSpinTime = 0;

        if (userRes.rows.length > 0) {
            const user = userRes.rows[0];
            isBanned = user.is_banned === 1;
            if (user.last_spin) {
                const cooldown = 24 * 60 * 60 * 1000;
                const elapsed = Date.now() - user.last_spin;
                if (elapsed < cooldown) {
                    nextSpinTime = user.last_spin + cooldown;
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

        res.json({ isBanned, nextSpinTime, isAdmin, prizes });
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
        const { userId, username } = req.body;
        const now = Date.now();

        let userRes = await db.execute({ sql: `SELECT * FROM users WHERE id = ?`, args: [userId] });
        
        if (userRes.rows.length > 0) {
            const user = userRes.rows[0];
            if (user.is_banned) return res.status(403).json({ error: 'Заблокирован' });
            if (user.last_spin && (now - user.last_spin) < 24 * 60 * 60 * 1000) {
                return res.status(400).json({ error: 'Рано крутить' });
            }
        }

        let prizesRes = await db.execute(`SELECT * FROM prizes`);
        let prizes = prizesRes.rows;
        if (prizes.length === 0) return res.status(400).json({ error: 'Нет призов' });

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
            sql: `INSERT INTO users (id, username, last_spin, is_banned) VALUES (?, ?, ?, 0) ON CONFLICT(id) DO UPDATE SET last_spin = ?, username = COALESCE(?, username)`,
            args: [userId, username, now, now, username]
        });

        await db.execute({
            sql: `INSERT INTO inventory (user_id, prize_id, promo_code, won_at) VALUES (?, ?, ?, ?)`,
            args: [userId, selectedPrize.id, promoCode, now]
        });

        res.json({ prize: selectedPrize, promoCode, prizesList: prizes });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/data', async (req, res) => {
    try {
        const adminId = req.query.adminId;
        const adminUsername = req.query.adminUsername;
        
        if (!await checkIsAdmin(adminId, adminUsername)) {
            return res.status(403).json({ error: 'Доступ запрещен' });
        }

        const usersRes = await db.execute(`SELECT id, username, last_spin, is_banned FROM users`);
        const adminsRes = await db.execute(`SELECT username FROM admins`);
        const prizesRes = await db.execute(`SELECT * FROM prizes`);

        res.json({
            users: usersRes.rows,
            admins: adminsRes.rows.map(a => a.username),
            prizes: prizesRes.rows
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/action', async (req, res) => {
    try {
        const { adminId, adminUsername, targetId, targetUsername, actionType, prizeData } = req.body;
        
        if (!await checkIsAdmin(adminId, adminUsername)) {
            return res.status(403).json({ message: 'Доступ запрещен' });
        }

        if (actionType === 'reset') {
            if (targetId) {
                await db.execute({ sql: `UPDATE users SET last_spin = NULL WHERE id = ?`, args: [targetId] });
            } else if (targetUsername) {
                const cleanName = targetUsername.replace('@', '').trim();
                await db.execute({ sql: `UPDATE users SET last_spin = NULL WHERE username = ?`, args: [cleanName] });
            }
            res.json({ message: 'Таймер успешно сброшен!' });
        } else if (actionType === 'ban') {
            let userRes;
            if (targetId) {
                userRes = await db.execute({ sql: `SELECT is_banned FROM users WHERE id = ?`, args: [targetId] });
            } else if (targetUsername) {
                const cleanName = targetUsername.replace('@', '').trim();
                userRes = await db.execute({ sql: `SELECT is_banned FROM users WHERE username = ?`, args: [cleanName] });
            }

            if (!userRes || userRes.rows.length === 0) {
                return res.status(404).json({ message: 'Пользователь не найден в базе' });
            }

            let newBanState = userRes.rows[0].is_banned === 1 ? 0 : 1;

            if (targetId) {
                await db.execute({ sql: `UPDATE users SET is_banned = ? WHERE id = ?`, args: [newBanState, targetId] });
            } else if (targetUsername) {
                const cleanName = targetUsername.replace('@', '').trim();
                await db.execute({ sql: `UPDATE users SET is_banned = ? WHERE username = ?`, args: [newBanState, cleanName] });
            }

            res.json({ message: newBanState === 1 ? 'Пользователь забанен' : 'Пользователь разбанен' });
        } else if (actionType === 'add_admin') {
            if (!targetUsername) return res.status(400).json({ message: 'Укажите юзернейм' });
            const cleanName = targetUsername.replace('@', '').trim();
            await db.execute({ sql: `INSERT OR IGNORE INTO admins (username) VALUES (?)`, args: [cleanName] });
            res.json({ message: `Админ @${cleanName} добавлен!` });
        } else if (actionType === 'remove_admin') {
            const cleanName = targetUsername.replace('@', '').trim();
            if (cleanName.toLowerCase() === 'ropogku') {
                return res.status(400).json({ message: 'Нельзя удалить главного администратора' });
            }
            await db.execute({ sql: `DELETE FROM admins WHERE username = ?`, args: [cleanName] });
            res.json({ message: `Админ @${cleanName} удален` });
        } else if (actionType === 'add_prize') {
            const { name, description, icon, weight, rarity } = prizeData;
            await db.execute({
                sql: `INSERT INTO prizes (name, description, icon, weight, rarity) VALUES (?, ?, ?, ?, ?)`,
                args: [name, description, icon || '🎁', weight || 10, rarity || 'common']
            });
            res.json({ message: 'Приз успешно добавлен!' });
        } else if (actionType === 'delete_prize') {
            await db.execute({
                sql: `DELETE FROM prizes WHERE id = ?`,
                args: [prizeData.id]
            });
            res.json({ message: 'Приз удален!' });
        }
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
