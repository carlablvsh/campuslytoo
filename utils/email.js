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

export async function sendResetPasswordEmail(toEmail, resetToken) {
  const fromAddress = process.env.SMTP_FROM || '"Campusly Support" <noreply@campusly.app>';
  const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173'; // Fallback to client URL

  const mailOptions = {
    from: fromAddress,
    to: toEmail,
    subject: 'Reset Your Campusly Password 🎀',
    text: `Hello,

You are receiving this email because you requested a password reset for your Campusly account.

Please use the following reset token to set a new password:
Token: ${resetToken}

If you did not request this, please ignore this email and your password will remain unchanged.

Cozy regards,
The Campusly Team`,
    html: `
      <div style="font-family: sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; border: 1.5px solid #ffd1dc; border-radius: 16px; background-color: #fffdf9; color: #3c2429;">
        <div style="text-align: center; margin-bottom: 20px;">
          <h2 style="color: #ff7899; margin: 0; font-family: serif; font-size: 1.8rem;">Campusly Planner</h2>
        </div>
        <p>Hello,</p>
        <p>You requested a password reset for your Campusly account. Copy the token below and paste it in the reset form to change your password:</p>
        
        <div style="text-align: center; margin: 25px 0;">
          <div style="display: inline-block; background-color: #ffffff; border: 2px dashed #ff7899; border-radius: 8px; padding: 12px 24px; font-size: 1.25rem; font-weight: bold; letter-spacing: 2px; color: #ff5e84;">
            ${resetToken}
          </div>
        </div>

        <p style="font-size: 0.82rem; color: #8c707a; line-height: 1.5;">
          This token is valid for 1 hour. If you did not request this reset, please ignore this email and your password will remain secure.
        </p>
        
        <hr style="border: 0; border-top: 1px solid rgba(255, 120, 153, 0.15); margin: 20px 0;" />
        <p style="font-size: 0.8rem; text-align: center; color: #8c707a; margin: 0;">
          Made with 💖 for a cozy campus life experience.
        </p>
      </div>
    `
  };

  try {
    const transporter = await getTransporter();
    if (transporter) {
      const info = await transporter.sendMail(mailOptions);
      console.log(`[EMAIL SERVICE] Reset email sent to ${toEmail}: ${info.messageId}`);
      
      // If Ethereal test mail, print the preview URL!
      const previewUrl = nodemailer.getTestMessageUrl(info);
      if (previewUrl) {
        console.log(`[EMAIL SERVICE] 📬 Ethereal Test Mail Preview URL: ${previewUrl}`);
      }
      return true;
    }
  } catch (err) {
    console.error(`[EMAIL SERVICE] Failed to send reset email to ${toEmail}:`, err);
  }

  // Fallback mock logs
  console.log(`\n======================================================`);
  console.log(`[EMAIL FALLBACK DIALOGUE]`);
  console.log(`To: ${toEmail}`);
  console.log(`Subject: Reset Your Campusly Password 🎀`);
  console.log(`Token: ${resetToken}`);
  console.log(`======================================================\n`);
  return false;
}
