const superAdminUsername = 'ТВОЙ_ТЕЛЕГРАМ_НИК'; // Твой ник в Telegram без @

const express = require('express');
const { createClient } = require('@libsql/client');

const app = express();
app.use(express.json());

// Подключение к облачной базе данных Turso
const db = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
});

// Инициализация таблицы при запуске сервера
async function initDB() {
    try {
        await db.execute(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                telegram_id TEXT UNIQUE,
                username TEXT,
                role TEXT DEFAULT 'user'
            )
        `);
        console.log('База данных Turso успешно инициализирована.');
    } catch (err) {
        console.error('Ошибка инициализации базы данных:', err);
    }
}

initDB();

// Эндпоинт для проверки и сохранения пользователя
app.post('/api/check-admin', async (req, res) => {
    try {
        const { telegram_id, username } = req.body;
        
        if (!telegram_id) {
            return res.status(400).json({ error: 'telegram_id is required' });
        }

        // Проверяем, является ли пользователь супер-админом по нику
        const isSuperAdmin = username && username.toLowerCase() === superAdminUsername.toLowerCase();
        const roleToAssign = isSuperAdmin ? 'admin' : 'user';

        // Проверяем, есть ли уже пользователь в базе
        const result = await db.execute({
            sql: 'SELECT * FROM users WHERE telegram_id = ?',
            args: [telegram_id]
        });

        if (result.rows.length === 0) {
            // Если пользователя нет, создаем его
            await db.execute({
                sql: 'INSERT INTO users (telegram_id, username, role) VALUES (?, ?, ?)',
                args: [telegram_id, username || '', roleToAssign]
            });
        } else {
            // Если пользователь есть, но это супер-админ, принудительно обновляем ему роль на admin
            if (isSuperAdmin && result.rows[0].role !== 'admin') {
                await db.execute({
                    sql: 'UPDATE users SET role = "admin" WHERE telegram_id = ?',
                    args: [telegram_id]
                });
            }
        }

        // Возвращаем актуальные данные о роли
        const finalUser = await db.execute({
            sql: 'SELECT * FROM users WHERE telegram_id = ?',
            args: [telegram_id]
        });

        res.json({ success: true, user: finalUser.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
