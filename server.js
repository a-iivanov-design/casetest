const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 10000;

const SUPER_ADMIN_USERNAME = 'ropogku';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const dbFile = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) {
        console.error('Ошибка подключения к базе данных', err.message);
    } else {
        console.log('Подключено к базе данных SQLite.');
        initDatabase();
    }
});

function initDatabase() {
    db.serialize(() => {
        // Переходим на уникальную идентификацию по username/id с отслеживанием времени последней прокрутки
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT,
            club_id TEXT DEFAULT 'default_club',
            last_spun TEXT,
            is_banned INTEGER DEFAULT 0
        )`);

        // Безопасное добавление колонок на случай обновления старой базы
        db.run(`ALTER TABLE users ADD COLUMN username TEXT`, (err) => {});
        db.run(`ALTER TABLE users ADD COLUMN last_spun TEXT`, (err) => {});
        db.run(`ALTER TABLE users ADD COLUMN is_banned INTEGER DEFAULT 0`, (err) => {});

        db.run(`CREATE TABLE IF NOT EXISTS prizes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            club_id TEXT DEFAULT 'default_club',
            name TEXT,
            icon TEXT,
            rarity TEXT,
            weight INTEGER,
            promo_prefix TEXT
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS inventory (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT,
            prize_name TEXT,
            icon TEXT,
            rarity TEXT,
            promo TEXT,
            won_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            is_used INTEGER DEFAULT 0
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS admins (
            telegram_id TEXT PRIMARY KEY,
            username TEXT,
            club_id TEXT DEFAULT 'default_club',
            role TEXT DEFAULT 'admin'
        )`);

        // Дефолтные призы
        db.get(`SELECT COUNT(*) as count FROM prizes`, (err, row) => {
            if (row && row.count === 0) {
                const defaultPrizes = [
                    { name: '30 мин', icon: '⏳', rarity: 'common', weight: 50, promo: 'TIME30' },
                    { name: '1 час', icon: '⏰', rarity: 'uncommon', weight: 30, promo: 'TIME60' },
                    { name: 'Энергетик', icon: '⚡', rarity: 'uncommon', weight: 15, promo: 'DRINK' },
                    { name: '3 часа', icon: '🎮', rarity: 'rare', weight: 4, promo: 'TIME180' },
                    { name: 'Ночной пакет', icon: '🌙', rarity: 'epic', weight: 1, promo: 'NIGHT' }
                ];

                const stmt = db.prepare(`INSERT INTO prizes (club_id, name, icon, rarity, weight, promo_prefix) VALUES (?, ?, ?, ?, ?, ?)`);
                defaultPrizes.forEach(p => {
                    stmt.run('default_club', p.name, p.icon, p.rarity, p.weight, p.promo);
                });
                stmt.finalize();
            }
        });
    });
}

function checkAdmin(userId, username, callback) {
    const cleanUsername = username ? username.replace('@', '').toLowerCase() : '';
    
    if (cleanUsername === SUPER_ADMIN_USERNAME.toLowerCase() || userId === SUPER_ADMIN_USERNAME) {
        return callback(true, 'default_club', true);
    }

    db.get(`SELECT club_id FROM admins WHERE telegram_id = ? OR LOWER(username) = ?`, [userId, cleanUsername], (err, row) => {
        if (row) {
            callback(true, row.club_id, false);
        } else {
            callback(false, null, false);
        }
    });
}

// Вспомогательная функция получения уникального ключа пользователя (приоритет юзернейму ТГ)
function getUserKey(userId, username) {
    const cleanUsername = username ? username.replace('@', '').trim().toLowerCase() : '';
    if (cleanUsername) {
        return `username_${cleanUsername}`;
    }
    return String(userId || 'test_user');
}

// Проверка статуса кейса (можно ли крутить / сколько осталось до конца кулдауна)
app.get('/api/status', (req, res) => {
    const userId = String(req.query.userId || '');
    const username = String(req.query.username || '');
    const userKey = getUserKey(userId, username);
    const cleanUsername = username ? username.replace('@', '').trim().toLowerCase() : null;

    // Ищем пользователя либо по его уникальному ключу, либо по юзернейму в поле username
    let query = `SELECT * FROM users WHERE id = ?`;
    let params = [userKey];

    if (cleanUsername) {
        query = `SELECT * FROM users WHERE id = ? OR LOWER(username) = ?`;
        params = [userKey, cleanUsername];
    }

    db.get(query, params, (err, user) => {
        if (err) return res.status(500).json({ error: 'Ошибка сервера' });

        if (user && user.is_banned === 1) {
            return res.json({ isBanned: true });
        }

        if (!user || !user.last_spun) {
            return res.json({ canSpin: true });
        }

        const lastSpunTime = new Date(user.last_spun).getTime();
        const now = Date.now();
        const diffHours = (now - lastSpunTime) / (1000 * 60 * 60);

        if (diffHours < 24) {
            const hoursLeft = Math.ceil(24 - diffHours);
            return res.json({ canSpin: false, hoursLeft });
        }

        res.json({ canSpin: true });
    });
});

// Эндпоинт прокрутки кейса с проверкой суточного кулдауна по юзернейму
app.post('/api/spin', (req, res) => {
    const userId = String(req.body.userId || 'test_user');
    const username = String(req.body.username || '');
    const clubId = req.body.clubId || 'default_club';

    const userKey = getUserKey(userId, username);
    const cleanUsername = username ? username.replace('@', '').trim().toLowerCase() : null;
    const isSuper = (cleanUsername === SUPER_ADMIN_USERNAME.toLowerCase() || userId === SUPER_ADMIN_USERNAME);

    let query = `SELECT * FROM users WHERE id = ?`;
    let params = [userKey];

    if (cleanUsername) {
        query = `SELECT * FROM users WHERE id = ? OR LOWER(username) = ?`;
        params = [userKey, cleanUsername];
    }

    db.get(query, params, (err, userRecord) => {
        if (userRecord && userRecord.is_banned === 1) {
            return res.status(403).json({ error: 'Вы заблокированы администратором!' });
        }

        // Проверка суточного кулдауна (для обычных пользователей)
        if (!isSuper && userRecord && userRecord.last_spun) {
            const lastSpunTime = new Date(userRecord.last_spun).getTime();
            const now = Date.now();
            const diffHours = (now - lastSpunTime) / (1000 * 60 * 60);

            if (diffHours < 24) {
                const hoursLeft = Math.ceil(24 - diffHours);
                return res.status(400).json({ error: `Кейс можно открывать раз в 24 часа. Подождите еще около ${hoursLeft} ч.` });
            }
        }

        db.all(`SELECT * FROM prizes WHERE club_id = ?`, [clubId], (err, prizes) => {
            if (err || !prizes.length) {
                return res.status(500).json({ error: 'Призы не найдены для этого клуба' });
            }

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

            // Записываем время последней прокрутки и привязываем юзернейм
            db.run(
                `INSERT INTO users (id, username, club_id, last_spun, is_banned) 
                 VALUES (?, ?, ?, datetime('now', 'utc'), 0)
                 ON CONFLICT(id) DO UPDATE SET last_spun = datetime('now', 'utc'), username = COALESCE(excluded.username, username)`,
                [userKey, cleanUsername || userId]
            );

            db.run(
                `INSERT INTO inventory (user_id, prize_name, icon, rarity, promo, won_at) VALUES (?, ?, ?, ?, ?, datetime('now', 'utc'))`,
                [userKey, winningPrize.name, winningPrize.icon, winningPrize.rarity, uniquePromo]
            );

            res.json({
                prize: { name: winningPrize.name, icon: winningPrize.icon, rarity: winningPrize.rarity },
                promo: uniquePromo
            });
        });
    });
});

// Инвентарь с поддержкой уникального ключа
app.get('/api/inventory', (req, res) => {
    const userId = String(req.query.userId || 'test_user');
    const username = String(req.query.username || '');
    const userKey = getUserKey(userId, username);

    db.all(`SELECT id, prize_name, icon, rarity, promo, won_at, is_used FROM inventory WHERE user_id = ? ORDER BY won_at DESC`, [userKey], (err, items) => {
        if (err) return res.status(500).json({ error: 'Ошибка получения инвентаря' });

        const now = new Date();
        const formattedItems = items.map(item => {
            let rawDate = item.won_at;
            if (!rawDate) {
                rawDate = new Date().toISOString();
            } else {
                rawDate = rawDate.trim();
                if (!rawDate.endsWith('Z') && !rawDate.includes('+')) {
                    rawDate = rawDate.replace(' ', 'T') + 'Z';
                }
            }
            
            const wonDate = new Date(rawDate);
            const isValidDate = !isNaN(wonDate.getTime());
            
            const diffHours = isValidDate ? (now - wonDate) / (1000 * 60 * 60) : 0;
            const isExpired = diffHours > 48;

            return {
                ...item,
                won_at: isValidDate ? wonDate.toISOString() : new Date().toISOString(),
                isExpired
            };
        });

        res.json({ items: formattedItems });
    });
});

// Проверка админа
app.get('/api/admin/check', (req, res) => {
    const userId = String(req.query.userId || '');
    const username = String(req.query.username || '');
    checkAdmin(userId, username, (isAdmin, clubId, isSuper) => {
        res.json({ isAdmin, clubId, isSuper });
    });
});

// Статистика для админки
app.get('/api/admin/stats', (req, res) => {
    const userId = String(req.query.userId || '');
    const username = String(req.query.username || '');
    checkAdmin(userId, username, (isAdmin) => {
        if (!isAdmin) return res.status(403).json({ error: 'Нет доступа' });

        db.get(`SELECT COUNT(*) as total_spins FROM inventory`, (err, row1) => {
            db.get(`SELECT COUNT(DISTINCT user_id) as total_users FROM users`, (err, row2) => {
                db.get(`SELECT COUNT(*) as banned_users FROM users WHERE is_banned = 1`, (err, row3) => {
                    res.json({
                        totalSpins: row1 ? row1.total_spins : 0,
                        totalUsers: row2 ? row2.total_users : 0,
                        bannedUsers: row3 ? row3.banned_users : 0
                    });
                });
            });
        });
    });
});

// Бан / Разбан пользователя по юзернейму
app.post('/api/admin/ban', (req, res) => {
    const { userId, username, targetUsername, banState } = req.body;
    checkAdmin(String(userId), String(username), (isAdmin) => {
        if (!isAdmin) return res.status(403).json({ error: 'Нет доступа' });

        const cleanTarget = targetUsername ? targetUsername.replace('@', '').trim().toLowerCase() : '';
        if (!cleanTarget) return res.status(400).json({ error: 'Укажите юзернейм!' });

        const dummyId = `username_${cleanTarget}`;
        db.run(
            `INSERT INTO users (id, username, is_banned) VALUES (?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET is_banned = ?`,
            [dummyId, cleanTarget, banState ? 1 : 0, banState ? 1 : 0],
            (err) => {
                if (err) return res.status(500).json({ error: 'Ошибка базы данных' });
                res.json({ success: true });
            }
        );
    });
});

// Список призов
app.get('/api/admin/prizes', (req, res) => {
    const userId = String(req.query.userId || '');
    const username = String(req.query.username || '');
    checkAdmin(userId, username, (isAdmin, clubId) => {
        if (!isAdmin) return res.status(403).json({ error: 'Нет доступа' });
        db.all(`SELECT * FROM prizes WHERE club_id = ?`, [clubId], (err, prizes) => {
            res.json({ prizes });
        });
    });
});

// Изменение веса приза
app.post('/api/admin/update-prize', (req, res) => {
    const { userId, username, prizeId, weight } = req.body;
    checkAdmin(String(userId), String(username), (isAdmin, clubId) => {
        if (!isAdmin) return res.status(403).json({ error: 'Нет доступа' });
        db.run(`UPDATE prizes SET weight = ? WHERE id = ? AND club_id = ?`, [weight, prizeId, clubId], (err) => {
            if (err) return res.status(500).json({ error: 'Ошибка обновления' });
            res.json({ success: true });
        });
    });
});

// Добавление приза
app.post('/api/admin/add-prize', (req, res) => {
    const { userId, username, name, icon, rarity, weight, promo_prefix } = req.body;
    checkAdmin(String(userId), String(username), (isAdmin, clubId) => {
        if (!isAdmin) return res.status(403).json({ error: 'Нет доступа' });
        db.run(
            `INSERT INTO prizes (club_id, name, icon, rarity, weight, promo_prefix) VALUES (?, ?, ?, ?, ?, ?)`,
            [clubId, name, icon, rarity, weight, promo_prefix],
            (err) => {
                if (err) return res.status(500).json({ error: 'Ошибка добавления' });
                res.json({ success: true });
            }
        );
    });
});

// Удаление приза
app.post('/api/admin/delete-prize', (req, res) => {
    const { userId, username, prizeId } = req.body;
    checkAdmin(String(userId), String(username), (isAdmin, clubId) => {
        if (!isAdmin) return res.status(403).json({ error: 'Нет доступа' });
        db.run(`DELETE FROM prizes WHERE id = ? AND club_id = ?`, [prizeId, clubId], (err) => {
            if (err) return res.status(500).json({ error: 'Ошибка удаления' });
            res.json({ success: true });
        });
    });
});

// Добавление нового администратора
app.post('/api/admin/add-admin', (req, res) => {
    const { userId, username, newAdminUsername, clubId } = req.body;
    checkAdmin(String(userId), String(username), (isAdmin, _, isSuper) => {
        if (!isSuper) return res.status(403).json({ error: 'Только главный администратор может добавлять других админов' });
        
        const cleanNewUsername = newAdminUsername ? newAdminUsername.replace('@', '').trim() : '';
        if (!cleanNewUsername) return res.status(400).json({ error: 'Укажите юзернейм!' });

        const dummyId = `username_${cleanNewUsername.toLowerCase()}`;

        db.run(
            `INSERT OR REPLACE INTO admins (telegram_id, username, club_id, role) VALUES (?, ?, ?, 'admin')`,
            [dummyId, cleanNewUsername, clubId || 'default_club'],
            (err) => {
                if (err) return res.status(500).json({ error: 'Ошибка добавления админа' });
                res.json({ success: true });
            }
        );
    });
});

app.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
