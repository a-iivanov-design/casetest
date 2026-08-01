import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@libsql/client';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:local.db',
  authToken: process.env.TURSO_AUTH_TOKEN || '',
});

async function initDb() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT,
      last_spin TEXT,
      is_banned INTEGER DEFAULT 0
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
      won_at TEXT
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      is_super INTEGER DEFAULT 0
    )
  `);

  // Удаляем старые битые записи пользователей без юзернейма (вроде null)
  await db.execute(`DELETE FROM users WHERE username IS NULL OR username = '' OR username = 'null'`);

  const adminCheck = await db.execute(`SELECT COUNT(*) as count FROM admins`);
  if (adminCheck.rows[0].count === 0) {
    await db.execute({
      sql: `INSERT INTO admins (username, is_super) VALUES (?, ?)`,
      args: ['ropogku', 1]
    });
  }
}
initDb();

app.get('/api/status', async (req, res) => {
  try {
    const { userId, username } = req.query;
    if (!userId) return res.status(400).json({ error: 'Missing userId' });

    const cleanUsername = username ? username.replace('@', '').toLowerCase() : '';
    if (!cleanUsername) return res.status(400).json({ error: 'Missing username' });

    let userRes = await db.execute({
      sql: `SELECT * FROM users WHERE username = ?`,
      args: [cleanUsername]
    });

    let user = userRes.rows[0];

    if (!user) {
      await db.execute({
        sql: `INSERT INTO users (id, username, last_spin, is_banned) VALUES (?, ?, NULL, 0)`,
        args: [String(userId), cleanUsername]
      });
      user = { id: String(userId), username: cleanUsername, last_spin: null, is_banned: 0 };
    } else {
      await db.execute({
        sql: `UPDATE users SET id = ? WHERE username = ?`,
        args: [String(userId), cleanUsername]
      });
    }

    if (user.is_banned === 1) {
      return res.json({ isBanned: true });
    }

    let canSpin = true;
    let hoursLeft = 0;

    if (user.last_spin) {
      const lastSpinDate = new Date(user.last_spin);
      const now = new Date();
      const diffHours = (now - lastSpinDate) / (1000 * 60 * 60);
      if (diffHours < 24) {
        canSpin = false;
        hoursLeft = Math.ceil(24 - diffHours);
      }
    }

    res.json({ isBanned: false, canSpin, hoursLeft });
  } catch (e) {
    console.error('API Status Error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/check', async (req, res) => {
  try {
    const { username } = req.query;
    if (!username) return res.json({ isAdmin: false });

    const cleanUsername = username.replace('@', '').toLowerCase();
    const adminRes = await db.execute({
      sql: `SELECT * FROM admins WHERE LOWER(username) = ?`,
      args: [cleanUsername]
    });

    if (adminRes.rows.length > 0) {
      res.json({ isAdmin: true, isSuper: adminRes.rows[0].is_super === 1 });
    } else {
      res.json({ isAdmin: false });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/spin', async (req, res) => {
  try {
    const { userId, username } = req.body;
    const cleanUsername = username ? username.replace('@', '').toLowerCase() : '';
    if (!cleanUsername) return res.status(400).json({ error: 'Missing username' });

    const userRes = await db.execute({
      sql: `SELECT * FROM users WHERE username = ?`,
      args: [cleanUsername]
    });

    const user = userRes.rows[0];
    if (!user || user.is_banned === 1) {
      return res.status(403).json({ isBanned: true, error: 'Аккаунт заблокирован' });
    }

    if (user.last_spin) {
      const diffHours = (new Date() - new Date(user.last_spin)) / (1000 * 60 * 60);
      if (diffHours < 24) {
        return res.status(400).json({ error: 'Кейс можно открывать раз в 24 часа' });
      }
    }

    const prizesRes = await db.execute(`SELECT * FROM prizes`);
    const prizes = prizesRes.rows;
    if (prizes.length === 0) {
      return res.status(400).json({ error: 'Призы не настроены администратором' });
    }

    let totalWeight = prizes.reduce((sum, p) => sum + p.weight, 0);
    let randomWeight = Math.random() * totalWeight;
    let chosenPrize = prizes[0];

    for (let p of prizes) {
      if (randomWeight < p.weight) {
        chosenPrize = p;
        break;
      }
      randomWeight -= p.weight;
    }

    const promoCode = `${chosenPrize.promo_prefix || 'CYBER'}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
    const nowIso = new Date().toISOString();

    await db.execute({
      sql: `UPDATE users SET last_spin = ? WHERE username = ?`,
      args: [nowIso, cleanUsername]
    });

    await db.execute({
      sql: `INSERT INTO inventory (user_id, prize_name, icon, promo, won_at) VALUES (?, ?, ?, ?, ?)`,
      args: [String(userId), chosenPrize.name, chosenPrize.icon || '🎁', promoCode, nowIso]
    });

    res.json({
      prize: {
        name: chosenPrize.name,
        icon: chosenPrize.icon,
        rarity: chosenPrize.rarity
      },
      promo: promoCode
    });
  } catch (e) {
    console.error('Spin Error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/inventory', async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.json({ items: [] });

    const itemsRes = await db.execute({
      sql: `SELECT * FROM inventory WHERE user_id = ? ORDER BY id DESC`,
      args: [String(userId)]
    });

    const now = new Date();
    const validItems = [];

    for (const item of itemsRes.rows) {
      const wonAt = new Date(item.won_at);
      const diffHours = (now - wonAt) / (1000 * 60 * 60);

      if (diffHours >= 48) {
        await db.execute({
          sql: `DELETE FROM inventory WHERE id = ?`,
          args: [item.id]
        });
      } else {
        validItems.push({
          ...item,
          hoursLeft: Math.ceil(48 - diffHours)
        });
      }
    }

    res.json({ items: validItems });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/prizes', async (req, res) => {
  try {
    const prizesRes = await db.execute(`SELECT * FROM prizes`);
    res.json({ prizes: prizesRes.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/add-prize', async (req, res) => {
  try {
    const { name, icon, rarity, weight, promo_prefix } = req.body;
    await db.execute({
      sql: `INSERT INTO prizes (name, icon, rarity, weight, promo_prefix) VALUES (?, ?, ?, ?, ?)`,
      args: [name, icon || '🎁', rarity || 'common', Number(weight) || 1, promo_prefix || 'PROMO']
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/delete-prize', async (req, res) => {
  try {
    const { prizeId } = req.body;
    await db.execute({
      sql: `DELETE FROM prizes WHERE id = ?`,
      args: [prizeId]
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/update-prize', async (req, res) => {
  try {
    const { prizeId, weight } = req.body;
    await db.execute({
      sql: `UPDATE prizes SET weight = ? WHERE id = ?`,
      args: [Number(weight), prizeId]
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/stats', async (req, res) => {
  try {
    const usersCount = await db.execute(`SELECT COUNT(*) as count FROM users WHERE username IS NOT NULL AND username != ''`);
    const bannedCount = await db.execute(`SELECT COUNT(*) as count FROM users WHERE is_banned = 1`);
    const spinsCount = await db.execute(`SELECT COUNT(*) as count FROM inventory`);

    res.json({
      totalUsers: usersCount.rows[0].count,
      bannedUsers: bannedCount.rows[0].count,
      totalSpins: spinsCount.rows[0].count
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/banned-list', async (req, res) => {
  try {
    const banned = await db.execute(`SELECT username FROM users WHERE is_banned = 1 AND username IS NOT NULL`);
    res.json({ bannedUsers: banned.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/users-list', async (req, res) => {
  try {
    const users = await db.execute(`SELECT id, username, is_banned FROM users WHERE username IS NOT NULL AND username != ''`);
    res.json({ users: users.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/ban', async (req, res) => {
  try {
    const { targetUsername, banState } = req.body;
    const cleanUser = targetUsername.replace('@', '').toLowerCase();
    await db.execute({
      sql: `UPDATE users SET is_banned = ? WHERE LOWER(username) = ?`,
      args: [Number(banState), cleanUser]
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/delete-user', async (req, res) => {
  try {
    const { targetIdentifier } = req.body;
    const cleanUser = targetIdentifier ? String(targetIdentifier).replace('@', '').toLowerCase() : '';
    await db.execute({
      sql: `DELETE FROM users WHERE LOWER(username) = ? OR id = ?`,
      args: [cleanUser, String(targetIdentifier)]
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/reset-timer', async (req, res) => {
  try {
    const { targetUsername } = req.body;
    const cleanUser = targetUsername.replace('@', '').toLowerCase();
    await db.execute({
      sql: `UPDATE users SET last_spin = NULL WHERE LOWER(username) = ?`,
      args: [cleanUser]
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/list', async (req, res) => {
  try {
    const admins = await db.execute(`SELECT username, is_super FROM admins`);
    res.json({ admins: admins.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/add-admin', async (req, res) => {
  try {
    const { newAdminUsername } = req.body;
    const cleanUser = newAdminUsername.replace('@', '').toLowerCase();
    await db.execute({
      sql: `INSERT OR IGNORE INTO admins (username, is_super) VALUES (?, 0)`,
      args: [cleanUser]
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/remove-admin', async (req, res) => {
  try {
    const { targetAdminUsername } = req.body;
    const cleanUser = targetAdminUsername.replace('@', '').toLowerCase();
    if (cleanUser === 'ropogku') {
      return res.status(400).json({ error: 'Нельзя удалить главного администратора' });
    }
    await db.execute({
      sql: `DELETE FROM admins WHERE LOWER(username) = ?`,
      args: [cleanUser]
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
