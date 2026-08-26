import jwt from 'jsonwebtoken';
import { dbGet, dbRun } from '../db.js';

const JWT_SECRET = process.env.JWT_SECRET || 'campusly_fallback_jwt_secret_key_13579';

export const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token missing or invalid.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;

    // Self-healing session restoration: if user is authenticated but missing in SQLite, re-insert them!
    try {
      const userExists = await dbGet('SELECT id FROM users WHERE id = ?', [decoded.userId]);
      if (!userExists) {
        console.log(`Self-healing session restore triggered for user ID: ${decoded.userId}`);
        const restoredUsername = decoded.username || 'student';
        const restoredEmail = decoded.email || `restored_${decoded.userId.substring(0, 5)}@campusly.app`;
        await dbRun(
          'INSERT INTO users (id, username, email, password_hash) VALUES (?, ?, ?, ?)',
          [decoded.userId, restoredUsername, restoredEmail, 'restored_placeholder_hash']
        );
        console.log(`Self-healed: restored user session in SQLite database.`);
      }
    } catch (dbErr) {
      console.error('Self-healing session restore failed:', dbErr);
    }

    next();
  } catch (err) {
    return res.status(403).json({ error: 'Token is expired or invalid.' });
  }
};
