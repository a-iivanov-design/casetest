import express from 'express';
import cors from 'cors';
import { createClient } from '@libsql/client';

const app = express();
app.use(express.json());
app.use(cors());

// Инициализация базы данных Turso
const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'libsql://your-db-url.turso.io',
  authToken: process.env.TURSO_AUTH_TOKEN || 'your-auth-token',
});

// Инициализация таблиц
async function initDb() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS inventory (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      item_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
}
initDb();

// Очистка просроченных предметов старше 48 часов
app.post('/api/inventory/cleanup', async (req, res) => {
  try {
    const thresholdTime = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    
    const expiredItems = await db.execute({
      sql: 'SELECT id FROM inventory WHERE created_at < ?',
      args: [thresholdTime]
    });

    if (expiredItems.rows.length > 0) {
      const idsToDelete = expiredItems.rows.map(row => row.id);
      
      for (const id of idsToDelete) {
        await db.execute({
          sql: 'DELETE FROM inventory WHERE id = ?',
          args: [id]
        });
      }
    }

    res.json({ success: true, deletedCount: expiredItems.rows.length });
  } catch (error) {
    console.error('Cleanup error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
