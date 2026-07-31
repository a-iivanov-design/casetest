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
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            club_id TEXT DEFAULT 'default_club',
            has_spun INTEGER DEFAULT 0
        )`);

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

        // Добавляем дефолтные призы только если таблица совсем пустая
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

// Эндпоинт прокрутки кейса
app.post('/api/spin', (req, res) => {
    const userId = String(req.body.userId || 'test_user');
    const username = String(req.body.username || '');
    const clubId = req.body.clubId || 'default_club';

    const cleanUsername = username.replace('@', '').toLowerCase();
    const isSuper = (cleanUsername === SUPER_ADMIN_USERNAME.toLowerCase() || userId === SUPER_ADMIN_USERNAME);

    const proceedWithSpin = () => {
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

            if (!isSuper) {
                db.run(`INSERT OR REPLACE INTO users (id, club_id, has_spun) VALUES (?, ?, 1)`, [userId, clubId]);
            }

            db.run(
                `INSERT INTO inventory (user_id, prize_name, icon, rarity, promo, won_at) VALUES (?, ?, ?, ?, ?, datetime('now', 'utc'))`,
                [userId, winningPrize.name, winningPrize.icon, winningPrize.rarity, uniquePromo]
            );

            res.json({
                prize: { name: winningPrize.name, icon: winningPrize.icon, rarity: winningPrize.rarity },
                promo: uniquePromo
            });
        });
    };

    if (isSuper) {
        proceedWithSpin();
    } else {
        db.get(`SELECT has_spun FROM users WHERE id = ?`, [userId], (err, user) => {
            if (user && user.has_spun === 1) {
                return res.status(400).json({ error: 'Вы уже открывали этот кейс!' });
            }
            proceedWithSpin();
        });
    }
});

// Инвентарь с безопасной обработкой дат и лимитом 48 часов
app.get('/api/inventory', (req, res) => {
    const userId = String(req.query.userId || 'test_user');
    db.all(`SELECT id, prize_name, icon, rarity, promo, won_at, is_used FROM inventory WHERE user_id = ? ORDER BY won_at DESC`, [userId], (err, items) => {
        if (err) return res.status(500).json({ error: 'Ошибка получения инвентаря' });

        const now = new Date();
        const formattedItems = items.map(item => {
            let rawDate = item.won_at;
            if (rawDate && !rawDate.endsWith('Z') && !rawDate.includes('+')) {
                rawDate = rawDate.replace(' ', 'T') + 'Z';
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
