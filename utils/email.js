import nodemailer from 'nodemailer';

let testAccountTransporter = null;

/**
 * Helper: Send email via Resend API
 */
async function sendResendEmail({ to, subject, html, text }) {
  const apiKey = process.env.RESEND_API_KEY;
  const fromAddress = process.env.RESEND_FROM || process.env.SMTP_FROM || 'Campusly <onboarding@resend.dev>';

  if (!apiKey) {
    return false;
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: fromAddress,
        to: Array.isArray(to) ? to : [to],
        subject,
        html,
        text
      })
    });

    const data = await response.json();

    if (!response.ok) {
      if (data && data.name === 'validation_error' && data.message && data.message.includes('only send testing emails')) {
        console.warn(`[RESEND NOTICE] Could not deliver email to ${to} because Resend is in Testing Mode (using onboarding@resend.dev). In testing mode, Resend ONLY delivers emails to the account owner (carlablvsh@gmail.com).`);
        return { success: false, isTestingRestriction: true };
      }
      console.error('[RESEND EMAIL SERVICE] Resend API error response:', data);
      return { success: false, error: data.message || 'Resend error' };
    }

    console.log(`[RESEND EMAIL SERVICE] 📬 Email successfully sent to ${to} via Resend. Message ID: ${data.id}`);
    return { success: true, delivered: true, id: data.id };
  } catch (err) {
    console.error('[RESEND EMAIL SERVICE] Failed to send email via Resend API:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Helper: Get SMTP / Ethereal transporter fallback
 */
async function getTransporter() {
  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT || 587;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (host && user && pass) {
    return nodemailer.createTransport({
      host,
      port: parseInt(port, 10),
      secure: parseInt(port, 10) === 465,
      auth: { user, pass }
    });
  }

  if (!testAccountTransporter) {
    console.log('[EMAIL SERVICE] Creating Ethereal testing SMTP account fallback...');
    try {
      const testAccount = await nodemailer.createTestAccount();
      testAccountTransporter = nodemailer.createTransport({
        host: 'smtp.ethereal.email',
        port: 587,
        secure: false,
        auth: {
          user: testAccount.user,
          pass: testAccount.pass
        }
      });
      console.log(`[EMAIL SERVICE] Ethereal test account created! User: ${testAccount.user}`);
    } catch (err) {
      console.error('[EMAIL SERVICE] Failed to create Ethereal SMTP test account:', err);
    }
  }

  return testAccountTransporter;
}

/**
 * Send 6-digit Verification OTP Email
 */
export async function sendVerificationOTPEmail(toEmail, otpCode) {
  const subject = `Your Campusly Verification Code is ${otpCode} 🎀`;
  const text = `Welcome to Campusly!

Your 6-digit verification code is: ${otpCode}

This code will expire in 10 minutes. Please enter this code in the app to complete your account setup.

Cozy regards,
The Campusly Team`;

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Campusly Verification Code</title>
</head>
<body style="margin: 0; padding: 20px; background-color: #fffdf9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #3c2429;">
  <div style="max-width: 500px; margin: 0 auto; background-color: #ffffff; border: 2px solid #ffd1dc; border-radius: 18px; padding: 32px; text-align: center; box-shadow: 0 4px 16px rgba(255, 120, 153, 0.1);">
    <div style="font-size: 38px; margin-bottom: 8px;">🎀</div>
    <h1 style="color: #ff5e84; margin: 0 0 4px 0; font-family: Georgia, serif; font-size: 26px; font-weight: 700;">Campusly</h1>
    <p style="color: #8c707a; font-size: 14px; margin: 0 0 24px 0;">Your Cozy Campus Planner</p>
    
    <p style="font-size: 16px; color: #4a3339; line-height: 1.5; margin-bottom: 24px;">Welcome to Campusly! Please enter the 6-digit verification code below to verify your email address and activate your account:</p>
    
    <div style="background-color: #fff0f3; border: 2px dashed #ff7899; border-radius: 14px; padding: 20px 28px; margin: 0 auto 24px auto; display: inline-block;">
      <span style="font-family: 'Courier New', Courier, monospace; font-size: 36px; font-weight: 800; letter-spacing: 10px; color: #d6336c;">${otpCode}</span>
    </div>
    
    <p style="font-size: 14px; color: #8c707a; margin-bottom: 24px;">This code will expire in <strong style="color: #d6336c;">10 minutes</strong>.</p>
    <hr style="border: none; border-top: 1px solid #ffe3e8; margin: 24px 0;">
    <p style="font-size: 12px; color: #a38893; margin: 0;">Made with 💖 for a seamless campus life experience.</p>
  </div>
</body>
</html>`;

  // 1. Primary: SMTP (Gmail / Custom SMTP)
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    try {
      const fromAddress = process.env.SMTP_FROM || 'Campusly Support <campusly.noreply@gmail.com>';
      const transporter = await getTransporter();
      if (transporter) {
        const info = await transporter.sendMail({ from: fromAddress, to: toEmail, subject, text, html });
        console.log(`[EMAIL SERVICE] 📬 OTP email successfully sent to ${toEmail} via SMTP: ${info.messageId}`);
        return { delivered: true };
      }
    } catch (err) {
      console.error(`[EMAIL SERVICE] SMTP error sending to ${toEmail}:`, err);
    }
  }

  // 2. Secondary: Resend API
  const resendResult = await sendResendEmail({ to: toEmail, subject, html, text });
  if (resendResult.success) {
    return { delivered: true };
  }

  return { delivered: false };
}

/**
 * Send Password Reset Link / OTP Email
 */
export async function sendResetPasswordEmail(toEmail, resetToken, otpCode) {
  const codeToDisplay = otpCode || resetToken;
  const subject = `Your Campusly Password Reset Code is ${codeToDisplay} 🔑`;
  const text = `Hello,

You requested a password reset for your Campusly account.

Your 6-digit reset code is: ${codeToDisplay}

This code is valid for 1 hour and can only be used once. If you did not request a password reset, please ignore this email.

Cozy regards,
The Campusly Team`;

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Campusly Password Reset</title>
</head>
<body style="margin: 0; padding: 20px; background-color: #fffdf9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #3c2429;">
  <div style="max-width: 500px; margin: 0 auto; background-color: #ffffff; border: 2px solid #ffd1dc; border-radius: 18px; padding: 32px; text-align: center; box-shadow: 0 4px 16px rgba(255, 120, 153, 0.1);">
    <div style="font-size: 38px; margin-bottom: 8px;">🔑</div>
    <h1 style="color: #ff5e84; margin: 0 0 4px 0; font-family: Georgia, serif; font-size: 26px; font-weight: 700;">Campusly</h1>
    <p style="color: #8c707a; font-size: 14px; margin: 0 0 24px 0;">Password Reset Request</p>
    
    <p style="font-size: 16px; color: #4a3339; line-height: 1.5; margin-bottom: 24px;">Hello, we received a request to reset your password. Copy the 6-digit code below to reset your password:</p>
    
    <div style="background-color: #fff0f3; border: 2px dashed #ff7899; border-radius: 14px; padding: 20px 28px; margin: 0 auto 24px auto; display: inline-block;">
      <span style="font-family: 'Courier New', Courier, monospace; font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #d6336c;">${codeToDisplay}</span>
    </div>
    
    <p style="font-size: 14px; color: #8c707a; margin-bottom: 24px;">This code is valid for <strong style="color: #d6336c;">1 hour</strong> and can only be used <strong style="color: #d6336c;">once</strong>.</p>
    <hr style="border: none; border-top: 1px solid #ffe3e8; margin: 24px 0;">
    <p style="font-size: 12px; color: #a38893; margin: 0;">Campusly Security • Made with 💖</p>
  </div>
</body>
</html>`;

  // 1. Primary: SMTP (Gmail / Custom SMTP)
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    try {
      const fromAddress = process.env.SMTP_FROM || 'Campusly Support <campusly.noreply@gmail.com>';
      const transporter = await getTransporter();
      if (transporter) {
        const info = await transporter.sendMail({ from: fromAddress, to: toEmail, subject, text, html });
        console.log(`[EMAIL SERVICE] 📬 Password reset email successfully sent to ${toEmail} via SMTP: ${info.messageId}`);
        return { delivered: true };
      }
    } catch (err) {
      console.error(`[EMAIL SERVICE] SMTP error sending reset email to ${toEmail}:`, err);
    }
  }

  // 2. Secondary: Resend API
  const resendResult = await sendResendEmail({ to: toEmail, subject, html, text });
  if (resendResult.success) {
    return { delivered: true };
  }

  return { delivered: false };
}
