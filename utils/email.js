import nodemailer from 'nodemailer';

let testAccountTransporter = null;

// Helper: Get email transporter
async function getTransporter() {
  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT || 587;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (host && user && pass) {
    // Return production configured SMTP transporter
    return nodemailer.createTransport({
      host,
      port: parseInt(port, 10),
      secure: parseInt(port, 10) === 465,
      auth: { user, pass }
    });
  }

  // Fallback / local testing: Create standard test account on Ethereal Email
  if (!testAccountTransporter) {
    console.log('[EMAIL SERVICE] No SMTP configurations detected. Creating Ethereal testing account...');
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
      console.error('[EMAIL SERVICE] Failed to create Ethereal SMTP test account, logging only:', err);
    }
  }

  return testAccountTransporter;
}

/**
 * Send 6-digit Verification OTP Email
 */
export async function sendVerificationOTPEmail(toEmail, otpCode) {
  const fromAddress = process.env.SMTP_FROM || '"Campusly Support" <noreply@campusly.app>';

  const mailOptions = {
    from: fromAddress,
    to: toEmail,
    subject: 'Verify Your Campusly Account 🎀',
    text: `Welcome to Campusly!

Your 6-digit verification code is: ${otpCode}

This code will expire in 10 minutes. Please enter this code in the app to complete your account setup.

Cozy regards,
The Campusly Team`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 28px; border: 1.5px solid #ffd1dc; border-radius: 20px; background-color: #fffdf9; color: #3c2429;">
        <div style="text-align: center; margin-bottom: 24px;">
          <div style="display: inline-flex; align-items: center; justify-content: center; width: 48px; height: 48px; background-color: #ffe3e8; border-radius: 14px; margin-bottom: 8px;">
            <span style="font-size: 24px;">🎀</span>
          </div>
          <h1 style="color: #ff5e84; margin: 6px 0 0 0; font-family: Georgia, serif; font-size: 1.8rem; font-weight: 700;">Campusly</h1>
          <p style="color: #8c707a; font-size: 0.88rem; margin-top: 4px;">Your Cozy Campus Planner</p>
        </div>

        <p style="font-size: 1rem; line-height: 1.5; color: #4a3339; margin-bottom: 16px;">Welcome! Please enter the 6-digit verification code below to verify your email address and activate your account:</p>
        
        <div style="text-align: center; margin: 28px 0;">
          <div style="display: inline-block; background: linear-gradient(135deg, #fff0f3 0%, #ffe3e8 100%); border: 2px dashed #ff7899; border-radius: 14px; padding: 16px 36px; font-family: 'Courier New', Courier, monospace; font-size: 2.2rem; font-weight: 800; letter-spacing: 10px; color: #d6336c; box-shadow: 0 4px 14px rgba(255, 120, 153, 0.12);">
            ${otpCode}
          </div>
        </div>

        <p style="font-size: 0.85rem; color: #8c707a; line-height: 1.6; text-align: center; margin-bottom: 24px;">
          This code is valid for <strong>10 minutes</strong>. If you did not create a Campusly account, please disregard this message.
        </p>
        
        <hr style="border: 0; border-top: 1px solid rgba(255, 120, 153, 0.2); margin: 24px 0;" />
        <p style="font-size: 0.78rem; text-align: center; color: #a38893; margin: 0;">
          Made with 💖 for a seamless campus life experience.
        </p>
      </div>
    `
  };

  try {
    const transporter = await getTransporter();
    if (transporter) {
      const info = await transporter.sendMail(mailOptions);
      console.log(`[EMAIL SERVICE] OTP verification email sent to ${toEmail}: ${info.messageId}`);
      const previewUrl = nodemailer.getTestMessageUrl(info);
      if (previewUrl) {
        console.log(`[EMAIL SERVICE] 📬 Ethereal OTP Test Mail Preview: ${previewUrl}`);
      }
      return true;
    }
  } catch (err) {
    console.error(`[EMAIL SERVICE] Failed to send OTP email to ${toEmail}:`, err);
  }

  // Fallback console log for local dev testing
  console.log(`\n======================================================`);
  console.log(`[EMAIL FALLBACK - VERIFICATION OTP]`);
  console.log(`To: ${toEmail}`);
  console.log(`Code: ${otpCode}`);
  console.log(`======================================================\n`);
  return false;
}

/**
 * Send Password Reset Link / OTP Email
 */
export async function sendResetPasswordEmail(toEmail, resetToken, otpCode) {
  const fromAddress = process.env.SMTP_FROM || '"Campusly Support" <noreply@campusly.app>';

  const mailOptions = {
    from: fromAddress,
    to: toEmail,
    subject: 'Reset Your Campusly Password 🔑',
    text: `Hello,

You requested a password reset for your Campusly account.

Your 6-digit reset code is: ${otpCode}
Reset Token: ${resetToken}

This reset code/token is valid for 1 hour and can only be used once. If you did not request a password reset, please ignore this email.

Cozy regards,
The Campusly Team`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 28px; border: 1.5px solid #ffd1dc; border-radius: 20px; background-color: #fffdf9; color: #3c2429;">
        <div style="text-align: center; margin-bottom: 24px;">
          <div style="display: inline-flex; align-items: center; justify-content: center; width: 48px; height: 48px; background-color: #ffe3e8; border-radius: 14px; margin-bottom: 8px;">
            <span style="font-size: 24px;">🔑</span>
          </div>
          <h1 style="color: #ff5e84; margin: 6px 0 0 0; font-family: Georgia, serif; font-size: 1.8rem; font-weight: 700;">Campusly</h1>
          <p style="color: #8c707a; font-size: 0.88rem; margin-top: 4px;">Password Reset Request</p>
        </div>

        <p style="font-size: 1rem; line-height: 1.5; color: #4a3339;">Hello,</p>
        <p style="font-size: 0.95rem; line-height: 1.5; color: #4a3339;">We received a request to reset your password for your Campusly account. Copy the 6-digit code or reset token below to reset your password:</p>
        
        <div style="text-align: center; margin: 24px 0;">
          <div style="display: inline-block; background: linear-gradient(135deg, #fff0f3 0%, #ffe3e8 100%); border: 2px dashed #ff7899; border-radius: 14px; padding: 14px 32px; font-family: 'Courier New', Courier, monospace; font-size: 2rem; font-weight: 800; letter-spacing: 8px; color: #d6336c; box-shadow: 0 4px 14px rgba(255, 120, 153, 0.12);">
            ${otpCode || resetToken}
          </div>
        </div>

        <p style="font-size: 0.85rem; color: #8c707a; line-height: 1.6; text-align: center; margin-bottom: 24px;">
          This code is valid for <strong>1 hour</strong> and can only be used <strong>once</strong>. If you did not request a password reset, you can safely ignore this email.
        </p>
        
        <hr style="border: 0; border-top: 1px solid rgba(255, 120, 153, 0.2); margin: 24px 0;" />
        <p style="font-size: 0.78rem; text-align: center; color: #a38893; margin: 0;">
          Campusly Security • Made with 💖
        </p>
      </div>
    `
  };

  try {
    const transporter = await getTransporter();
    if (transporter) {
      const info = await transporter.sendMail(mailOptions);
      console.log(`[EMAIL SERVICE] Reset email sent to ${toEmail}: ${info.messageId}`);
      const previewUrl = nodemailer.getTestMessageUrl(info);
      if (previewUrl) {
        console.log(`[EMAIL SERVICE] 📬 Ethereal Reset Test Mail Preview: ${previewUrl}`);
      }
      return true;
    }
  } catch (err) {
    console.error(`[EMAIL SERVICE] Failed to send reset email to ${toEmail}:`, err);
  }

  // Fallback console log for local dev testing
  console.log(`\n======================================================`);
  console.log(`[EMAIL FALLBACK - PASSWORD RESET]`);
  console.log(`To: ${toEmail}`);
  console.log(`Code/Token: ${otpCode || resetToken}`);
  console.log(`======================================================\n`);
  return false;
}
