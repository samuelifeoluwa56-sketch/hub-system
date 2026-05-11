"use strict";

const nodemailer = require("nodemailer");
const config = require("../../config/config");
const logger = require("../../config/logger");

const transporter = nodemailer.createTransport({
  host: config.smtp.host,
  port: config.smtp.port,
  secure: config.smtp.port === 465,
  auth: {
    user: config.smtp.user,
    pass: config.smtp.pass,
  },
});

async function sendEmail({
  to,
  subject,
  html,
  attachments = [],
  from,
  replyTo,
}) {
  const mail = {
    from: from || `"${config.smtp.fromName}" <${config.smtp.fromEmail}>`,
    to,
    subject,
    html,
    attachments,
    replyTo,
  };

  try {
    const info = await transporter.sendMail(mail);
    logger.debug(`Email sent to ${to}: ${info.messageId}`);
    return info;
  } catch (err) {
    logger.error(`Email failed to ${to}`, err);
    throw err;
  }
}

async function sendWithAttachment({
  to,
  subject,
  html,
  filename,
  pdfBuffer,
  from,
}) {
  return sendEmail({
    to,
    subject,
    html,
    from,
    attachments: [
      { filename, content: pdfBuffer, contentType: "application/pdf" },
    ],
  });
}

module.exports = { sendEmail, sendWithAttachment };
