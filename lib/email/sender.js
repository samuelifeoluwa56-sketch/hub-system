"use strict";

const nodemailer = require("nodemailer");
const config = require("../../config/config");
const logger = require("../../config/logger");
const signature = require("./signature");

const transporter = nodemailer.createTransport({
  host: config.smtp.host,
  port: config.smtp.port,
  secure: config.smtp.port === 465,
  auth: {
    user: config.smtp.user,
    pass: config.smtp.pass,
  },
});

/**
 * Send an email.
 *
 * If `senderUserId` and `senderBusiness` are provided, the staff
 * member's stored signature is auto-appended to the HTML body — this
 * is the Module 12 promise that every outbound staff email carries
 * the personalised branded signature.
 *
 * If omitted (e.g. system emails like password resets), no signature
 * is appended.
 *
 * @param {Object} opts
 * @param {string} opts.to
 * @param {string} opts.subject
 * @param {string} opts.html
 * @param {Array}  [opts.attachments]
 * @param {string} [opts.from]
 * @param {string} [opts.replyTo]
 * @param {string} [opts.senderUserId]   triggers signature append
 * @param {string} [opts.senderBusiness] triggers signature append
 */
async function sendEmail({
  to,
  subject,
  html,
  attachments = [],
  from,
  replyTo,
  senderUserId,
  senderBusiness,
}) {
  // Auto-append signature if we know who's sending and from which business.
  // Failures inside appendToHTML are swallowed there — we never want a
  // missing signature to prevent the email from going out.
  let finalHtml = html;
  if (senderUserId && senderBusiness) {
    finalHtml = await signature.appendToHTML(
      html,
      senderUserId,
      senderBusiness,
    );
  }

  const mail = {
    from: from || `"${config.smtp.fromName}" <${config.smtp.fromEmail}>`,
    to,
    subject,
    html: finalHtml,
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
  senderUserId,
  senderBusiness,
}) {
  return sendEmail({
    to,
    subject,
    html,
    from,
    senderUserId,
    senderBusiness,
    attachments: [
      { filename, content: pdfBuffer, contentType: "application/pdf" },
    ],
  });
}

module.exports = { sendEmail, sendWithAttachment };
