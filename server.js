const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 10000;

// Твой Telegram ID как главного администратора (без лимитов)
const SUPER_ADMIN_ID = '@ropogku'; // Замени на свой цифровой ID или оставь пока так для тестов

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
            won_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // Таблица администраторов клубов (по Telegram ID или username)
        db.run(`CREATE TABLE IF NOT EXISTS admins (
            telegram_id TEXT PRIMARY KEY,
            club_id TEXT DEFAULT 'default_club',
            role TEXT DEFAULT 'admin'
        )`);

        // Добавляем тестового супер-админа
        db.run(`INSERT OR IGNORE INTO admins (telegram_id, club_id, role) VALUES (?, ?, ?)`, [SUPER_ADMIN_ID, 'default_club', 'superadmin']);

        db.get(`SELECT COUNT(*) as count FROM prizes`, (err, row) => {
            if (row.count === 0) {
                const defaultPrizes = [
                    { name: '30 мин', icon: '⏳', rarity: 'common', weight: 50, promo: 'TIME30' },
                    { name: '1 час', icon: '⏰', rarity: 'uncommon', weight: 30, promo: 'TIME60' },
                    { name: 'Энергетик', icon: '⚡', rarity: 'uncommon', weight: 15, promo: 'DRINK' },
                    { name: '3 часа', icon: '🎮', rarity: 'rare', weight: 4, promo: 'TIME180' },
                    { name: 'Ночной пакет', icon: '🌙', rarity: 'epic', weight: 1, promo: 'NIGHT' }
                ];

                const stmt = db.prepare(`INSERT INTO prizes (name, icon, rarity, weight, promo_prefix) VALUES (?, ?, ?, ?, ?)`);
                defaultPrizes.forEach(p => {
                    stmt.run(p.name, p.icon, p.rarity, p.weight, p.promo);
                });
                stmt.finalize();
            }
        });
    });
}

// Проверка прав администратора
function checkAdmin(userId, callback) {
    if (userId === SUPER_ADMIN_ID) {
        return callback(true, 'default_club');
    }
    db.get(`SELECT club_id FROM admins WHERE telegram_id = ?`, [userId], (err, row) => {
        if (row) {
            callback(true, row.club_id);
        } else {
            callback(false, null);
        }
    });
}

// Эндпоинт прокрутки кейса с исключением для админа
app.post('/api/spin', (req, res) => {
    const userId = String(req.body.userId || 'test_user');
    const clubId = req.body.clubId || 'default_club';

    const isSuper = (userId === SUPER_ADMIN_ID);

    // Если не супер-админ, проверяем лимит
    const proceedWithSpin = () => {
        db.all(`SELECT * FROM prizes WHERE club_id = ?`, [clubId], (err, prizes) => {
            if (err || !prizes.length) {
                return res.status(500).json({ error: 'Призы не найдены' });
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

            // Блокируем повтор только для обычных пользователей
            if (!isSuper) {
                db.run(`INSERT OR REPLACE INTO users (id, club_id, has_spun) VALUES (?, ?, 1)`, [userId, clubId]);
            }

            db.run(
                `INSERT INTO inventory (user_id, prize_name, icon, rarity, promo) VALUES (?, ?, ?, ?, ?)`,
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

// Получение инвентаря
app.get('/api/inventory', (req, res) => {
    const userId = String(req.query.userId || 'test_user');
    db.all(`SELECT prize_name, icon, rarity, promo, won_at FROM inventory WHERE user_id = ? ORDER BY won_at DESC`, [userId], (err, items) => {
        if (err) return res.status(500).json({ error: 'Ошибка' });
        res.json({ items });
    });
});

// Проверка: является ли пользователь админом
app.get('/api/admin/check', (req, res) => {
    const userId = String(req.query.userId || '');
    checkAdmin(userId, (isAdmin, clubId) => {
        res.json({ isAdmin, clubId });
    });
});

// Получение списка призов для админки
app.get('/api/admin/prizes', (req, res) => {
    const userId = String(req.query.userId || '');
    checkAdmin(userId, (isAdmin, clubId) => {
        if (!isAdmin) return res.status(403.json({ error: 'Нет доступа' }));
        db.all(`SELECT * FROM prizes WHERE club_id = ?`, [clubId], (err, prizes) => {
            res.json({ prizes });
        });
    });
});

// Изменение шанса / веса приза
app.post('/api/admin/update-prize', (req, res) => {
    const { userId, prizeId, weight } = req.body;
    checkAdmin(String(userId), (isAdmin, clubId) => {
        if (!isAdmin) return res.status(403).json({ error: 'Нет доступа' });
        db.run(`UPDATE prizes SET weight = ? WHERE id = ? AND club_id = ?`, [weight, prizeId, clubId], (err) => {
            if (err) return res.status(500).json({ error: 'Ошибка обновления' });
            res.json({ success: true });
        });
    });
});

// Добавление нового приза
app.post('/api/admin/add-prize', (req, res) => {
    const { userId, name, icon, rarity, weight, promo_prefix } = req.body;
    checkAdmin(String(userId), (isAdmin, clubId) => {
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
    const { userId, prizeId }`, (req, res) => { ... });

app.post('/api/admin/delete-prize', (req, res) => {
    const { userId, prizeId } = req.body;
    checkAdmin(String(userId), (isAdmin, clubId) => {
        if (!isAdmin) return res.status(403).json({ error: 'Нет доступа' });
        db.run(`DELETE FROM prizes WHERE id = ? AND club_id = ?`, [prizeId, clubId], (err) => {
            if (err) return res.status(500).json({ error: 'Ошибка удаления' });
            res.json({ success: true });
        });
    });
});

app.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
