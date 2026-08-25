import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.resolve(__dirname, 'campusly.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database', err.message);
  } else {
    console.log('Connected to SQLite database at:', dbPath);
  }
});

// Helper utilities to wrap sqlite3 queries in Promises
export const dbRun = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) {
        reject(err);
      } else {
        resolve({ id: this.lastID, changes: this.changes });
      }
    });
  });
};

export const dbGet = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
      } else {
        resolve(row);
      }
    });
  });
};

export const dbAll = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
};

// Initialize database schema tables
export const initDB = async () => {
  try {
    // Enable Foreign Keys support
    await dbRun('PRAGMA foreign_keys = ON;');

    // Users Table
    await dbRun(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        avatar_url TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Migration: Add avatar_url column to users table if it doesn't exist
    try {
      await dbRun('ALTER TABLE users ADD COLUMN avatar_url TEXT');
      console.log('Database migration: added avatar_url column to users table.');
    } catch (err) {
      // Safe to ignore if column already exists
    }

    // Subjects Table
    await dbRun(`
      CREATE TABLE IF NOT EXISTS subjects (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        code TEXT NOT NULL,
        target_attendance INTEGER DEFAULT 75,
        color TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Classes / Timetable Table
    await dbRun(`
      CREATE TABLE IF NOT EXISTS classes (
        id TEXT PRIMARY KEY,
        subject_id TEXT NOT NULL,
        day_of_week INTEGER NOT NULL, -- 0=Sunday, 1=Monday, ..., 6=Saturday
        start_time TEXT NOT NULL,      -- 'HH:MM'
        end_time TEXT NOT NULL,        -- 'HH:MM'
        location TEXT,
        FOREIGN KEY(subject_id) REFERENCES subjects(id) ON DELETE CASCADE
      )
    `);

    // Attendance Logs Table
    await dbRun(`
      CREATE TABLE IF NOT EXISTS attendance_logs (
        id TEXT PRIMARY KEY,
        subject_id TEXT NOT NULL,
        date TEXT NOT NULL,            -- 'YYYY-MM-DD'
        status TEXT NOT NULL,          -- 'present', 'absent', 'cancelled'
        FOREIGN KEY(subject_id) REFERENCES subjects(id) ON DELETE CASCADE
      )
    `);

    // Assignments Table
    await dbRun(`
      CREATE TABLE IF NOT EXISTS assignments (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        due_date TEXT NOT NULL,        -- 'YYYY-MM-DD'
        status TEXT DEFAULT 'pending', -- 'pending', 'completed'
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(subject_id) REFERENCES subjects(id) ON DELETE CASCADE
      )
    `);

    // Exams Table
    await dbRun(`
      CREATE TABLE IF NOT EXISTS exams (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        title TEXT NOT NULL,
        date TEXT NOT NULL,            -- 'YYYY-MM-DD'
        start_time TEXT NOT NULL,      -- 'HH:MM'
        location TEXT,
        syllabus TEXT,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(subject_id) REFERENCES subjects(id) ON DELETE CASCADE
      )
    `);

    // Notes Table
    await dbRun(`
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        title TEXT NOT NULL,
        file_name TEXT NOT NULL,
        content_extracted TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(subject_id) REFERENCES subjects(id) ON DELETE CASCADE
      )
    `);

    // Calendar Notes Table
    await dbRun(`
      CREATE TABLE IF NOT EXISTS calendar_notes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        date TEXT NOT NULL, -- 'YYYY-MM-DD'
        note TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    console.log('All database tables initialized successfully.');
  } catch (error) {
    console.error('Error initializing database tables:', error);
  }
};

export default db;
