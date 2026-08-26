const loginAttempts = {};

export const loginLimiter = (req, res, next) => {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  const now = Date.now();
  
  if (loginAttempts[ip]) {
    const { count, lastAttempt } = loginAttempts[ip];
    
    // If blocked (max 5 attempts within 1 minute)
    if (count >= 5 && now - lastAttempt < 60 * 1000) {
      const remainingTime = Math.ceil((60 * 1000 - (now - lastAttempt)) / 1000);
      return res.status(429).json({ 
        error: `Too many login attempts. Please try again in ${remainingTime} seconds.` 
      });
    }
    
    // Reset/clear old count if last attempt was > 1 min ago
    if (now - lastAttempt > 60 * 1000) {
      loginAttempts[ip] = { count: 1, lastAttempt: now };
    } else {
      loginAttempts[ip].count += 1;
      loginAttempts[ip].lastAttempt = now;
    }
  } else {
    loginAttempts[ip] = { count: 1, lastAttempt: now };
  }
  
  next();
};
