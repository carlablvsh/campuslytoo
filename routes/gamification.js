import express from 'express';
import { dbAll, dbGet, dbRun } from '../db.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// Server-controlled XP values (cannot be altered by client)
export const XP_CONFIG = {
  ATTENDANCE_MARKED: 20,
  ASSIGNMENT_COMPLETED: 15,
  STUDY_SESSION_POMODORO: 30,
  DAILY_STREAK: 10,
  ACHIEVEMENT_UNLOCKED: 50,
};

// Level titles
const LEVEL_TITLES = [
  'Freshman Explorer',    // Lvl 1
  'Curious Scholar',      // Lvl 2
  'Focused Learner',      // Lvl 3
  'Campus Regular',       // Lvl 4
  'Diligent Achiever',    // Lvl 5
  'Knowledge Seeker',     // Lvl 6
  'Study Master',         // Lvl 7
  'Academic Veteran',     // Lvl 8
  'Campus Luminary',      // Lvl 9
  'Academic Weapon'       // Lvl 10+
];

// Helper: Calculate Level data from Total XP
export const getLevelData = (totalXP) => {
  const safeXP = Math.max(0, totalXP || 0);
  
  // Progressive curve: Level 1 requires 100 XP, Level 2 requires 150 more, Level 3 requires 200 more...
  // Cumulative XP for level L:
  // L1: 0 - 99
  // L2: 100 - 249
  // L3: 250 - 449
  // L4: 450 - 699
  // L5: 700 - 999
  // L6: 1000 - 1349
  let level = 1;
  let currentLevelBaseXP = 0;
  let nextLevelXP = 100;
  let step = 100;

  while (safeXP >= nextLevelXP && level < 50) {
    level++;
    currentLevelBaseXP = nextLevelXP;
    step += 50;
    nextLevelXP += step;
  }

  const xpIntoLevel = safeXP - currentLevelBaseXP;
  const xpNeededForNext = nextLevelXP - currentLevelBaseXP;
  const progressPercent = Math.min(100, Math.max(0, Math.round((xpIntoLevel / xpNeededForNext) * 100)));
  const titleIndex = Math.min(level - 1, LEVEL_TITLES.length - 1);

  return {
    level,
    levelTitle: LEVEL_TITLES[titleIndex],
    currentXP: safeXP,
    currentLevelBaseXP,
    nextLevelTargetXP: nextLevelXP,
    xpIntoLevel,
    xpRemaining: nextLevelXP - safeXP,
    progressPercent
  };
};

// Helper: Award server-controlled XP with strict deduplication
export const awardXP = async (userId, action, source, referenceId, metadata = {}) => {
  try {
    if (!userId || !action || !source) return null;

    // Check idempotency: if referenceId is provided, prevent duplicate awards
    if (referenceId) {
      const existing = await dbGet(
        'SELECT id FROM xp_logs WHERE user_id = ? AND reference_id = ?',
        [userId, referenceId]
      );
      if (existing) {
        return null; // Already awarded
      }
    }

    let xpAmount = 0;
    switch (action) {
      case 'attendance_marked':
        xpAmount = XP_CONFIG.ATTENDANCE_MARKED;
        break;
      case 'assignment_completed':
        xpAmount = XP_CONFIG.ASSIGNMENT_COMPLETED;
        break;
      case 'study_session':
        xpAmount = XP_CONFIG.STUDY_SESSION_POMODORO;
        break;
      case 'daily_streak':
        xpAmount = XP_CONFIG.DAILY_STREAK;
        break;
      case 'achievement_unlocked':
        xpAmount = XP_CONFIG.ACHIEVEMENT_UNLOCKED;
        break;
      default:
        xpAmount = 10;
    }

    const logId = 'xp_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
    const metaStr = typeof metadata === 'string' ? metadata : JSON.stringify(metadata);

    await dbRun(
      `INSERT INTO xp_logs (id, user_id, action, xp_amount, source, reference_id, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [logId, userId, action, xpAmount, source, referenceId || null, metaStr]
    );

    return { id: logId, xpAmount, action };
  } catch (err) {
    console.error('Error awarding XP:', err);
    return null;
  }
};

// Helper: Synchronize / backfill historical real activity into XP logs safely
const syncHistoricalActivity = async (userId) => {
  try {
    // 1. Sync present attendance logs for this user's subjects
    const presentLogs = await dbAll(
      `SELECT al.id, al.subject_id, al.date, s.name as subject_name, s.code as subject_code
       FROM attendance_logs al
       JOIN subjects s ON al.subject_id = s.id
       WHERE s.user_id = ? AND al.status = 'present'`,
      [userId]
    );

    for (const log of presentLogs) {
      const refId = `att_${log.subject_id}_${log.date}`;
      await awardXP(userId, 'attendance_marked', 'attendance', refId, {
        subject_name: log.subject_name,
        subject_code: log.subject_code,
        date: log.date
      });
    }

    // 2. Sync completed assignments
    const completedAssignments = await dbAll(
      `SELECT a.id, a.title, s.name as subject_name, s.code as subject_code
       FROM assignments a
       JOIN subjects s ON a.subject_id = s.id
       WHERE a.user_id = ? AND a.status = 'completed'`,
      [userId]
    );

    for (const ass of completedAssignments) {
      const refId = `ass_${ass.id}`;
      await awardXP(userId, 'assignment_completed', 'assignments', refId, {
        assignment_title: ass.title,
        subject_code: ass.subject_code
      });
    }
  } catch (err) {
    console.error('Error syncing historical activity to XP:', err);
  }
};

// Helper: Calculate streaks from user activity dates
const calculateStreak = async (userId) => {
  try {
    // Fetch distinct active dates from attendance and XP logs
    const datesRows = await dbAll(
      `SELECT DISTINCT date_str FROM (
         SELECT date as date_str FROM attendance_logs al JOIN subjects s ON al.subject_id = s.id WHERE s.user_id = ?
         UNION
         SELECT substr(created_at, 1, 10) as date_str FROM xp_logs WHERE user_id = ?
       ) WHERE date_str IS NOT NULL ORDER BY date_str DESC`,
      [userId, userId]
    );

    const activeDates = datesRows.map(r => r.date_str).filter(Boolean);
    if (activeDates.length === 0) {
      return { currentStreak: 0, longestStreak: 0, activeDaysThisWeek: [] };
    }

    const dateSet = new Set(activeDates);

    // Format local date YYYY-MM-DD
    const formatDate = (d) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };

    const now = new Date();
    const todayStr = formatDate(now);
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = formatDate(yesterday);

    let currentStreak = 0;
    let checkDate = new Date(now);

    // If today is not logged yet, start checking from yesterday to preserve streak
    if (!dateSet.has(todayStr)) {
      if (dateSet.has(yesterdayStr)) {
        checkDate = yesterday;
      } else {
        checkDate = null;
      }
    }

    if (checkDate) {
      while (true) {
        const dStr = formatDate(checkDate);
        if (dateSet.has(dStr)) {
          currentStreak++;
          checkDate.setDate(checkDate.getDate() - 1);
        } else {
          break;
        }
      }
    }

    // Calculate this week's active days (Monday to Sunday)
    const currentDayOfWeek = (now.getDay() + 6) % 7; // 0=Mon, ..., 6=Sun
    const monday = new Date(now);
    monday.setDate(now.getDate() - currentDayOfWeek);

    const activeDaysThisWeek = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      const dStr = formatDate(d);
      activeDaysThisWeek.push({
        dayName: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][i],
        date: dStr,
        isActive: dateSet.has(dStr),
        isToday: dStr === todayStr
      });
    }

    return {
      currentStreak,
      longestStreak: Math.max(currentStreak, activeDates.length > 0 ? Math.min(activeDates.length, 7) : 0),
      activeDaysThisWeek
    };
  } catch (err) {
    console.error('Error calculating streak:', err);
    return { currentStreak: 0, longestStreak: 0, activeDaysThisWeek: [] };
  }
};

// Achievement Template Definitions
const ACHIEVEMENT_DEFINITIONS = [
  {
    id: 'first_step',
    title: 'First Step',
    description: 'Complete your first assignment or task in Campusly.',
    category: 'Productivity',
    badgeIcon: '🎯',
    xpReward: 50,
    target: 1,
  },
  {
    id: 'task_master',
    title: 'Task Master',
    description: 'Complete 5 assignments or project deliverables.',
    category: 'Productivity',
    badgeIcon: '📝',
    xpReward: 75,
    target: 5,
  },
  {
    id: 'academic_weapon',
    title: 'Academic Weapon',
    description: 'Complete 15 assignments across your enrolled subjects.',
    category: 'Productivity',
    badgeIcon: '⚔️',
    xpReward: 150,
    target: 15,
  },
  {
    id: 'study_starter',
    title: 'Study Starter',
    description: 'Complete your first focus session in the Study Room.',
    category: 'Focus',
    badgeIcon: '☕',
    xpReward: 50,
    target: 1,
  },
  {
    id: 'deep_worker',
    title: 'Deep Worker',
    description: 'Complete 5 focused Pomodoro sessions in the Study Room.',
    category: 'Focus',
    badgeIcon: '🧘',
    xpReward: 80,
    target: 5,
  },
  {
    id: 'zen_master',
    title: 'Zen Master',
    description: 'Complete 15 focus sessions in the Study Room.',
    category: 'Focus',
    badgeIcon: '🌌',
    xpReward: 150,
    target: 15,
  },
  {
    id: 'first_lecture',
    title: 'First Lecture',
    description: 'Log your first attended class on the Calendar or Attendance.',
    category: 'Academic',
    badgeIcon: '🎒',
    xpReward: 50,
    target: 1,
  },
  {
    id: 'class_regular',
    title: 'Class Regular',
    description: 'Attend 10 scheduled timetable lectures.',
    category: 'Academic',
    badgeIcon: '🎓',
    xpReward: 100,
    target: 10,
  },
  {
    id: 'attendance_ace',
    title: 'Attendance Ace',
    description: 'Attend 25 scheduled timetable lectures.',
    category: 'Academic',
    badgeIcon: '🌟',
    xpReward: 150,
    target: 25,
  },
  {
    id: 'consistent_scholar',
    title: 'Consistent Scholar',
    description: 'Maintain a 3-day daily study & attendance streak.',
    category: 'Consistency',
    badgeIcon: '⚡',
    xpReward: 60,
    target: 3,
  },
  {
    id: 'on_fire',
    title: 'On Fire',
    description: 'Maintain a 7-day daily study & attendance streak.',
    category: 'Consistency',
    badgeIcon: '🔥',
    xpReward: 120,
    target: 7,
  },
  {
    id: 'century_club',
    title: 'Century Club',
    description: 'Accumulate 500 total XP across all academic activities.',
    category: 'Milestone',
    badgeIcon: '🏆',
    xpReward: 100,
    target: 500,
  },
  {
    id: 'grand_scholar',
    title: 'Grand Scholar',
    description: 'Accumulate 1,500 total XP and master your semester.',
    category: 'Milestone',
    badgeIcon: '👑',
    xpReward: 200,
    target: 1500,
  }
];

// Helper: Evaluate achievements dynamically against real records
const evaluateAchievements = async (userId, currentStreak, totalXP) => {
  try {
    // 1. Fetch completed assignments count
    const assRow = await dbGet(
      'SELECT COUNT(*) as count FROM assignments WHERE user_id = ? AND status = "completed"',
      [userId]
    );
    const completedAssignmentsCount = assRow ? assRow.count : 0;

    // 2. Fetch attended classes count
    const attRow = await dbGet(
      `SELECT COUNT(*) as count FROM attendance_logs al 
       JOIN subjects s ON al.subject_id = s.id 
       WHERE s.user_id = ? AND al.status = "present"`,
      [userId]
    );
    const attendedClassesCount = attRow ? attRow.count : 0;

    // 3. Fetch completed study sessions count from xp_logs
    let studySessionsCount = 0;
    try {
      const studyRow = await dbGet(
        'SELECT COUNT(*) as count FROM xp_logs WHERE user_id = ? AND action = "study_session"',
        [userId]
      );
      studySessionsCount = studyRow ? studyRow.count : 0;
    } catch (e) {
      console.error('Error querying study sessions count:', e);
    }

    // 4. Fetch already unlocked achievements from DB safely
    let unlockedRows = [];
    try {
      unlockedRows = await dbAll(
        'SELECT achievement_id, unlocked_at FROM user_achievements WHERE user_id = ?',
        [userId]
      );
    } catch (e) {
      console.error('Error querying user_achievements table:', e);
    }

    const safeUnlockedRows = Array.isArray(unlockedRows) ? unlockedRows : [];
    const unlockedMap = new Map(safeUnlockedRows.map(r => [r.achievement_id, r.unlocked_at]));

    // Evaluate each definition
    const evaluated = [];

    for (const def of ACHIEVEMENT_DEFINITIONS) {
      let progress = 0;
      switch (def.id) {
        case 'first_step':
        case 'task_master':
        case 'academic_weapon':
          progress = completedAssignmentsCount;
          break;
        case 'study_starter':
        case 'deep_worker':
        case 'zen_master':
          progress = studySessionsCount;
          break;
        case 'first_lecture':
        case 'class_regular':
        case 'attendance_ace':
          progress = attendedClassesCount;
          break;
        case 'consistent_scholar':
        case 'on_fire':
          progress = currentStreak;
          break;
        case 'century_club':
        case 'grand_scholar':
          progress = totalXP;
          break;
        default:
          progress = 0;
      }

      const isEligible = progress >= def.target;
      let unlockedAt = unlockedMap.get(def.id) || null;

      // If eligible but not yet recorded in user_achievements, record it and award achievement XP once!
      if (isEligible && !unlockedAt) {
        unlockedAt = new Date().toISOString();
        const achRecordId = 'ach_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
        try {
          await dbRun(
            'INSERT OR IGNORE INTO user_achievements (id, user_id, achievement_id, unlocked_at) VALUES (?, ?, ?, ?)',
            [achRecordId, userId, def.id, unlockedAt]
          );
          // Award XP for achievement unlock
          await awardXP(userId, 'achievement_unlocked', 'achievements', `ach_${def.id}`, {
            achievement_id: def.id,
            title: def.title
          });
        } catch (e) {
          console.error('Error recording achievement unlock:', e);
        }
      }

      evaluated.push({
        id: def.id,
        title: def.title,
        description: def.description,
        category: def.category,
        badgeIcon: def.badgeIcon,
        xpReward: def.xpReward,
        target: def.target,
        progress: Math.min(progress, def.target),
        isUnlocked: !!unlockedAt || isEligible,
        unlockedAt: unlockedAt || null
      });
    }

    return evaluated;
  } catch (err) {
    console.error('Error evaluating achievements:', err);
    return ACHIEVEMENT_DEFINITIONS.map(def => ({
      id: def.id,
      title: def.title,
      description: def.description,
      category: def.category,
      badgeIcon: def.badgeIcon,
      xpReward: def.xpReward,
      target: def.target,
      progress: 0,
      isUnlocked: false,
      unlockedAt: null
    }));
  }
};

// =========================================================================
// ROUTE: GET /api/gamification/summary
// Comprehensive user progression metrics
// =========================================================================
router.get('/summary', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId || req.user?.id;

    // 1. Sync existing historical activity once on first visit so existing records count
    const existingXPLog = await dbGet('SELECT 1 FROM xp_logs WHERE user_id = ? LIMIT 1', [userId]);
    if (!existingXPLog) {
      await syncHistoricalActivity(userId);
    }

    // 2. Fetch total XP from server-controlled xp_logs
    const xpRow = await dbGet(
      'SELECT COALESCE(SUM(xp_amount), 0) as total_xp FROM xp_logs WHERE user_id = ?',
      [userId]
    );
    const totalXP = xpRow ? xpRow.total_xp : 0;

    // 3. Compute Level and Progression
    const levelData = getLevelData(totalXP);

    // 4. Compute Streaks
    const streakData = await calculateStreak(userId);

    // 5. Evaluate Achievements
    const achievements = await evaluateAchievements(userId, streakData.currentStreak, totalXP);

    // 6. Fetch Recent Activity Feed (Latest 15 entries)
    const recentActivity = await dbAll(
      `SELECT id, action, xp_amount, source, metadata, created_at
       FROM xp_logs
       WHERE user_id = ?
       ORDER BY datetime(created_at) DESC, rowid DESC
       LIMIT 15`,
      [userId]
    );

    // Format activity for friendly display
    const formattedActivity = recentActivity.map(act => {
      let meta = {};
      try {
        meta = act.metadata ? JSON.parse(act.metadata) : {};
      } catch (e) {}

      let displayTitle = 'Earned XP';
      let icon = '✦';

      switch (act.action) {
        case 'attendance_marked':
          displayTitle = `Attended ${meta.subject_code || meta.subject_name || 'Class'}`;
          icon = '✓';
          break;
        case 'assignment_completed':
          displayTitle = `Completed ${meta.assignment_title || 'Assignment'}`;
          icon = '📋';
          break;
        case 'study_session':
          displayTitle = `${meta.minutes || 25}-Min Study Session`;
          icon = '☕';
          break;
        case 'daily_streak':
          displayTitle = 'Daily Activity Streak Bonus';
          icon = '🔥';
          break;
        case 'achievement_unlocked':
          displayTitle = `Unlocked "${meta.title || 'Achievement'}"`;
          icon = '🏆';
          break;
        default:
          displayTitle = 'Academic Activity';
      }

      return {
        id: act.id,
        action: act.action,
        xpAmount: act.xp_amount,
        source: act.source,
        displayTitle,
        icon,
        createdAt: act.created_at
      };
    });

    // 7. Future Rewards Showcase (Real themes & profile frames unlockable in profile)
    const futureRewards = [
      {
        id: 'theme_matcha',
        title: 'Matcha Sage Color Theme',
        type: 'Theme Palette',
        reqLevel: 3,
        icon: '🌿',
        isUnlocked: levelData.level >= 3
      },
      {
        id: 'frame_emerald',
        title: 'Emerald Scholar Avatar Frame',
        type: 'Profile Frame',
        reqLevel: 4,
        icon: '💎',
        isUnlocked: levelData.level >= 4
      },
      {
        id: 'theme_ocean',
        title: 'Ocean Breeze Color Theme',
        type: 'Theme Palette',
        reqLevel: 5,
        icon: '🌊',
        isUnlocked: levelData.level >= 5
      },
      {
        id: 'theme_lavender',
        title: 'Lavender Dream Color Theme',
        type: 'Theme Palette',
        reqLevel: 7,
        icon: '💜',
        isUnlocked: levelData.level >= 7
      },
      {
        id: 'frame_sapphire',
        title: 'Sapphire Honor Avatar Frame',
        type: 'Profile Frame',
        reqLevel: 8,
        icon: '👑',
        isUnlocked: levelData.level >= 8
      },
      {
        id: 'theme_peach',
        title: 'Sunset Peach Color Theme',
        type: 'Theme Palette',
        reqLevel: 10,
        icon: '🍑',
        isUnlocked: levelData.level >= 10
      },
      {
        id: 'frame_gold',
        title: 'Golden Legend Avatar Frame',
        type: 'Profile Frame',
        reqLevel: 12,
        icon: '✨',
        isUnlocked: levelData.level >= 12
      },
      {
        id: 'frame_starlight',
        title: 'Starlight Halo Avatar Frame',
        type: 'Profile Frame',
        reqLevel: 15,
        icon: '🌟',
        isUnlocked: levelData.level >= 15
      }
    ];

    res.json({
      totalXP,
      level: levelData.level,
      levelTitle: levelData.levelTitle,
      currentLevelBaseXP: levelData.currentLevelBaseXP,
      nextLevelTargetXP: levelData.nextLevelTargetXP,
      xpIntoLevel: levelData.xpIntoLevel,
      xpRemaining: levelData.xpRemaining,
      progressPercent: levelData.progressPercent,
      currentStreak: streakData.currentStreak,
      longestStreak: streakData.longestStreak,
      activeDaysThisWeek: streakData.activeDaysThisWeek,
      achievements,
      recentActivity: formattedActivity,
      futureRewards,
      xpSources: [
        { action: 'Attend a Class', xp: `+${XP_CONFIG.ATTENDANCE_MARKED} XP`, icon: '✓', desc: 'Recorded on Calendar or Attendance' },
        { action: 'Complete Assignment', xp: `+${XP_CONFIG.ASSIGNMENT_COMPLETED} XP`, icon: '📋', desc: 'Marked completed in Assignments' },
        { action: 'Study Room Session', xp: `+${XP_CONFIG.STUDY_SESSION_POMODORO} XP`, icon: '☕', desc: 'Complete a focus timer block' },
        { action: 'Daily Consistency Streak', xp: `+${XP_CONFIG.DAILY_STREAK} XP`, icon: '🔥', desc: 'Active daily student bonus' },
        { action: 'Unlock Achievements', xp: `+${XP_CONFIG.ACHIEVEMENT_UNLOCKED} XP`, icon: '🏆', desc: 'Milestone & consistency badges' },
      ]
    });
  } catch (err) {
    console.error('Error fetching gamification summary:', err);
    res.status(500).json({ error: 'Failed to load progression summary.' });
  }
});

// =========================================================================
// ROUTE: POST /api/gamification/study-session
// Triggered on completing a verified study room session (server awards XP)
// =========================================================================
router.post('/study-session', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId || req.user?.id;
    const { minutes = 25, session_id } = req.body;

    // Must be at least 10 minutes to count for XP
    if (minutes < 10) {
      return res.status(400).json({ error: 'Study session must be at least 10 minutes to earn XP.' });
    }

    const refId = session_id || `study_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const result = await awardXP(userId, 'study_session', 'study_room', refId, {
      minutes: Number(minutes)
    });

    if (!result) {
      return res.json({ message: 'Session already credited or not eligible.' });
    }

    res.json({
      success: true,
      awardedXP: result.xpAmount,
      message: `Great focus! You earned +${result.xpAmount} XP.`
    });
  } catch (err) {
    console.error('Error logging study session XP:', err);
    res.status(500).json({ error: 'Failed to record study session.' });
  }
});

export default router;
